import { randomUUID } from "node:crypto"
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./hash.js"

export class PathBoundaryError extends Error {
  constructor() {
    super("Path is outside the Snapshot Root")
    this.name = "PathBoundaryError"
  }
}

export class FileNotFoundError extends Error {
  constructor(displayPath) {
    super(`File does not exist: ${displayPath}`)
    this.name = "FileNotFoundError"
    this.code = "ENOENT"
  }
}

export class NotAFileError extends Error {
  constructor(displayPath) {
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

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function decodeBytes(bytes) {
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
  constructor({ root, roots = [] }) {
    this.root = path.resolve(root)
    this.extraRoots = roots.map((candidate) => path.resolve(candidate))
    this._rootsPromise = null
  }

  async _snapshotRoots() {
    if (!this._rootsPromise) {
      this._rootsPromise = Promise.all([this.root, ...this.extraRoots].map((candidate) => realpath(candidate)))
    }
    return this._rootsPromise
  }

  async _rootForLexicalPath(candidate) {
    const roots = await this._snapshotRoots()
    return roots.find((root) => isInside(root, candidate)) ?? null
  }

  async resolve(inputPath, baseDirectory = this.root) {
    if (typeof inputPath !== "string" || inputPath.trim() === "") {
      throw new Error("path must be a non-empty string")
    }

    const displayPath = inputPath
    const lexicalPath = path.resolve(baseDirectory, inputPath)
    const lexicalRoot = await this._rootForLexicalPath(lexicalPath)
    if (!lexicalRoot) throw new PathBoundaryError()

    let canonicalPath
    try {
      canonicalPath = await realpath(lexicalPath)
    } catch (error) {
      if (error?.code === "ENOENT") throw new FileNotFoundError(displayPath)
      throw error
    }

    const roots = await this._snapshotRoots()
    const rootPath = roots.find((root) => isInside(root, canonicalPath))
    if (!rootPath) throw new PathBoundaryError()

    let information
    try {
      information = await stat(canonicalPath)
    } catch (error) {
      if (error?.code === "ENOENT") throw new FileNotFoundError(displayPath)
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

  async read(inputPath, baseDirectory = this.root) {
    const resolved = await this.resolve(inputPath, baseDirectory)
    const bytes = await readFile(resolved.canonicalPath)
    const decoded = decodeBytes(bytes)
    await this._assertStillResolved(resolved, baseDirectory)
    return { ...resolved, bytes, ...decoded }
  }

  async _assertStillResolved(resolved, baseDirectory = this.root) {
    const current = await this.resolve(resolved.inputPath, baseDirectory)
    if (current.canonicalPath !== resolved.canonicalPath || current.rootId !== resolved.rootId) {
      throw new PathBoundaryError()
    }
    return current
  }

  async _readNormalized(resolved) {
    const bytes = await readFile(resolved.canonicalPath)
    return decodeBytes(bytes)
  }

  /**
   * Commit a normalized text replacement using tmp → fsync → revalidate → rename.
   */
  async writeAtomic({
    inputPath,
    baseDirectory = this.root,
    canonicalPath,
    rootId,
    expectedText,
    newText,
    lineEnding,
    bom,
    beforeRename,
  }) {
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
    let handle
    try {
      handle = await open(temporaryPath, "wx")
      await handle.writeFile(persistedText, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined

      if (beforeRename) await beforeRename()

      const current = await this.resolve(inputPath, baseDirectory)
      if (current.canonicalPath !== canonicalPath || current.rootId !== rootId) throw new PathBoundaryError()
      const liveBeforeRename = await this._readNormalized(current)
      if (liveBeforeRename.text !== expectedText) throw new LiveFileChangedError()

      await rename(temporaryPath, canonicalPath)
      return { persistedText, canonicalPath, rootId }
    } catch (error) {
      if (handle) {
        try {
          await handle.close()
        } catch {}
      }
      throw error
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
  }
}
