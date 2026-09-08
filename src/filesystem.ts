import { randomUUID } from "node:crypto"
import { open, readFile, realpath, rename, rm, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"

import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./hash.ts"

export class PathBoundaryError extends Error {
  constructor() {
    super("Path is outside the Snapshot Root")
    this.name = "PathBoundaryError"
  }
}

export class FileNotFoundError extends Error {
  code: string
  constructor(displayPath: string) {
    super(`File does not exist: ${displayPath}`)
    this.name = "FileNotFoundError"
    this.code = "ENOENT"
  }
}

export class NotAFileError extends Error {
  constructor(displayPath: string) {
    super(`Path is not a file: ${displayPath}`)
    this.name = "NotAFileError"
  }
}

export class LiveFileChangedError extends Error {
  constructor() {
    super("Live file changed before commit; re-read and retry")
    this.name = "LiveFileChangedError"
  }
}

export interface ResolvedFile {
  inputPath: string
  displayPath: string
  canonicalPath: string
  rootPath: string
  rootId: string
  lexicalRoot: string
}

export interface DecodedFile {
  rawText: string
  text: string
  lineEnding: string
  bom: boolean
}

export interface ReadFileResult extends ResolvedFile, DecodedFile {
  bytes: Buffer
}

export interface AtomicWriteInput {
  inputPath: string
  baseDirectory?: string
  canonicalPath: string
  rootId: string
  expectedText: string
  newText: string
  lineEnding: string
  bom: boolean
  beforeRename?: () => unknown
}

export interface PreparedAtomic extends AtomicWriteInput {
  persistedText: string
  temporaryPath: string
}

export interface CommittedAtomic {
  persistedText: string
  canonicalPath: string
  rootId: string
}

export interface FileSystemAdapterOptions {
  root: string
  roots?: string[]
  rename?: typeof rename
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function decodeBytes(bytes: Buffer): DecodedFile {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const rawText = bytes.toString("utf8")
  const textWithoutBom = stripBom(rawText)
  return {
    rawText,
    text: normalizeToLF(textWithoutBom),
    lineEnding: detectLineEnding(textWithoutBom),
    bom: hasBom || rawText.startsWith("\uFEFF"),
  }
}

/** Filesystem adapter with realpath-based Snapshot Root confinement. */
export class FileSystemAdapter {
  root: string
  extraRoots: string[]
  _rootsPromise: Promise<string[]> | null
  renameFile: typeof rename

  constructor({ root, roots = [], rename: renameOperation }: FileSystemAdapterOptions) {
    this.root = path.resolve(root)
    this.extraRoots = roots.map((candidate) => path.resolve(candidate))
    this._rootsPromise = null
    this.renameFile = renameOperation ?? rename
  }

  async _snapshotRoots(): Promise<string[]> {
    if (!this._rootsPromise) {
      this._rootsPromise = Promise.all([this.root, ...this.extraRoots].map((candidate) => realpath(candidate)))
    }
    return this._rootsPromise
  }

  async _rootForLexicalPath(candidate: string): Promise<string | null> {
    const roots = await this._snapshotRoots()
    return roots.find((root) => isInside(root, candidate)) ?? null
  }

  async resolve(inputPath: string, baseDirectory: string = this.root): Promise<ResolvedFile> {
    if (typeof inputPath !== "string" || inputPath.trim() === "") {
      throw new Error("path must be a non-empty string")
    }

    const displayPath = inputPath
    const lexicalPath = path.resolve(baseDirectory, inputPath)
    const lexicalRoot = await this._rootForLexicalPath(lexicalPath)
    if (!lexicalRoot) throw new PathBoundaryError()

    let canonicalPath: string
    try {
      canonicalPath = await realpath(lexicalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new FileNotFoundError(displayPath)
      throw error
    }

    const roots = await this._snapshotRoots()
    const rootPath = roots.find((root) => isInside(root, canonicalPath))
    if (!rootPath) throw new PathBoundaryError()

    let information
    try {
      information = await stat(canonicalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new FileNotFoundError(displayPath)
      throw error
    }
    if (!information.isFile()) throw new NotAFileError(displayPath)

    return {
      inputPath,
      displayPath,
      canonicalPath,
      rootPath,
      rootId: rootPath,
      lexicalRoot,
    }
  }

  async read(inputPath: string, baseDirectory: string = this.root): Promise<ReadFileResult> {
    const resolved = await this.resolve(inputPath, baseDirectory)
    const bytes = await readFile(resolved.canonicalPath)
    const decoded = decodeBytes(bytes)
    await this._assertStillResolved(resolved, baseDirectory)
    return { ...resolved, bytes, ...decoded }
  }

  async _assertStillResolved(
    resolved: ResolvedFile,
    baseDirectory: string = this.root,
  ): Promise<ResolvedFile> {
    const current = await this.resolve(resolved.inputPath, baseDirectory)
    if (current.canonicalPath !== resolved.canonicalPath || current.rootId !== resolved.rootId) {
      throw new PathBoundaryError()
    }
    return current
  }

  async _readNormalized(resolved: { canonicalPath: string }): Promise<DecodedFile> {
    const bytes = await readFile(resolved.canonicalPath)
    return decodeBytes(bytes)
  }

  /** Stage a normalized replacement without changing the target file. */
  async prepareAtomic({
    inputPath,
    baseDirectory = this.root,
    canonicalPath,
    rootId,
    expectedText,
    newText,
    lineEnding,
    bom,
    beforeRename,
  }: AtomicWriteInput): Promise<PreparedAtomic> {
    const initial = await this.resolve(inputPath, baseDirectory)
    if (initial.canonicalPath !== canonicalPath || initial.rootId !== rootId) throw new PathBoundaryError()

    const liveBefore = await this._readNormalized(initial)
    if (liveBefore.text !== expectedText) throw new LiveFileChangedError()

    const directory = path.dirname(initial.canonicalPath)
    const temporaryPath = path.join(
      directory,
      `.${path.basename(initial.canonicalPath)}.hashline-${randomUUID()}.tmp`,
    )
    const persistedText = restoreLineEndings(newText, lineEnding, bom)
    let handle: FileHandle | undefined
    let staged = false
    let operationError: unknown
    try {
      handle = await open(temporaryPath, "wx")
      await handle.writeFile(persistedText, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      staged = true
      return {
        inputPath,
        baseDirectory,
        canonicalPath,
        rootId,
        expectedText,
        newText,
        lineEnding,
        bom,
        persistedText,
        temporaryPath,
        beforeRename,
      }
    } catch (error) {
      operationError = error
      if (handle) {
        try {
          await handle.close()
        } catch {}
      }
      throw error
    } finally {
      if (!staged) {
        try {
          await rm(temporaryPath, { force: true })
        } catch (cleanupError) {
          if (operationError) (operationError as Record<string, unknown>).cleanupError = cleanupError
          else throw cleanupError
        }
      }
    }
  }

  async discardPrepared(prepared: PreparedAtomic | null | undefined): Promise<void> {
    if (!prepared?.temporaryPath) return
    try {
      await rm(prepared.temporaryPath, { force: true })
    } catch (error) {
      ;(error as Record<string, unknown>).temporaryPath = prepared.temporaryPath
      throw error
    }
  }

  /** Revalidate a staged replacement immediately before its rename. */
  async commitPrepared(prepared: PreparedAtomic): Promise<CommittedAtomic> {
    let operationError: unknown
    let result: CommittedAtomic | undefined
    try {
      if (prepared.beforeRename) await prepared.beforeRename()
      const current = await this.resolve(prepared.inputPath, prepared.baseDirectory)
      if (current.canonicalPath !== prepared.canonicalPath || current.rootId !== prepared.rootId) {
        throw new PathBoundaryError()
      }
      const liveBeforeRename = await this._readNormalized(current)
      if (liveBeforeRename.text !== prepared.expectedText) throw new LiveFileChangedError()

      await this.renameFile(prepared.temporaryPath, prepared.canonicalPath)
      result = {
        persistedText: prepared.persistedText,
        canonicalPath: prepared.canonicalPath,
        rootId: prepared.rootId,
      }
    } catch (error) {
      operationError = error
    }

    try {
      await this.discardPrepared(prepared)
    } catch (cleanupError) {
      if (operationError) {
        ;(operationError as Record<string, unknown>).cleanupError = cleanupError
      } else {
        operationError = cleanupError
        ;(operationError as Record<string, unknown>).committed = true
        ;(operationError as Record<string, unknown>).persistedText = prepared.persistedText
        ;(operationError as Record<string, unknown>).canonicalPath = prepared.canonicalPath
        ;(operationError as Record<string, unknown>).rootId = prepared.rootId
      }
    }

    if (operationError) throw operationError
    return result as CommittedAtomic
  }

  /** Restore a pre-image using the same staged tmp → fsync → rename path. */
  async restoreAtomic({
    inputPath,
    baseDirectory = this.root,
    canonicalPath,
    rootId,
    expectedText,
    newText,
    lineEnding,
    bom,
  }: AtomicWriteInput): Promise<CommittedAtomic> {
    const prepared = await this.prepareAtomic({
      inputPath,
      baseDirectory,
      canonicalPath,
      rootId,
      expectedText,
      newText,
      lineEnding,
      bom,
    })
    return this.commitPrepared(prepared)
  }

  /**
   * Commit one normalized text replacement using tmp → fsync → revalidate → rename.
   */
  async writeAtomic(input: AtomicWriteInput): Promise<CommittedAtomic> {
    const prepared = await this.prepareAtomic(input)
    return this.commitPrepared(prepared)
  }
}
