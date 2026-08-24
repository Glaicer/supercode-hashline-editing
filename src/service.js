import path from "node:path"

import {
  computeTag,
  formatNumberedLines,
  normalizeToLF,
  splitAddressableLines,
  stripBom,
} from "./hash.js"
import {
  BoundaryError,
  DuplicateHunkError,
  HashlineError,
  LineRangeError,
  MismatchError,
  MissingFileError,
  NoChangesError,
  SnapshotRequiredError,
} from "./errors.js"
import {
  FileNotFoundError,
  FileSystemAdapter,
  PathBoundaryError,
} from "./filesystem.js"
import { parsePatch } from "./parser.js"
import { InMemorySnapshotStore, SnapshotStoreLimits } from "./snapshots.js"

function asLineNumbers(start, lines) {
  return new Set(lines.map((_, index) => start + index))
}

function capabilityKey(inputPath, rootId) {
  return `${rootId}\u0000${inputPath}`
}

function mapFilesystemError(error, operation, displayPath) {
  if (error instanceof PathBoundaryError) return new BoundaryError()
  if (error instanceof FileNotFoundError && operation === "edit") return new MissingFileError(displayPath)
  return error
}

function applyReplacements(text, hunks) {
  const lines = splitAddressableLines(text)
  const lineCount = lines.length
  const ordered = [...hunks].sort((left, right) => left.start - right.start || left.end - right.end)

  for (const hunk of ordered) {
    if (hunk.start < 1 || hunk.end > lineCount) {
      const missingLine = hunk.start > lineCount ? hunk.start : hunk.end
      throw new LineRangeError(missingLine, lineCount)
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start <= ordered[index - 1].end) throw new DuplicateHunkError()
  }

  const hadTerminalNewline = text.endsWith("\n")
  const result = [...lines]
  for (const hunk of [...ordered].reverse()) {
    result.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...hunk.body)
  }
  const after = result.join("\n") + (hadTerminalNewline ? "\n" : "")
  return {
    after,
    firstChangedLine: ordered.length > 0 ? ordered[0].start : undefined,
  }
}

function formatHeader(filePath, tag) {
  return `[${filePath}#${tag}]`
}

/** Main public read/edit seam for the foundation ticket. */
export class HashlineService {
  constructor({
    worktree,
    directory = worktree,
    roots = [],
    filesystem,
    store,
    maxPaths = SnapshotStoreLimits.maxPaths,
    maxVersionsPerPath = SnapshotStoreLimits.maxVersionsPerPath,
    maxTotalBytes = SnapshotStoreLimits.maxTotalBytes,
  }) {
    if (!worktree) throw new TypeError("worktree is required")
    this.worktree = path.resolve(worktree)
    this.directory = path.resolve(directory)
    this.filesystem = filesystem ?? new FileSystemAdapter({ root: this.worktree, roots })
    this.readCapabilities = new Map()
    this.store =
      store ??
      new InMemorySnapshotStore({
        maxPaths,
        maxVersionsPerPath,
        maxTotalBytes,
      })
  }

  async _readFile(inputPath, operation) {
    try {
      return await this.filesystem.read(inputPath, this.directory)
    } catch (error) {
      throw mapFilesystemError(error, operation, inputPath)
    }
  }

  async read(inputPath, limit, offset) {
    const file = await this._readFile(inputPath, "read")
    const lines = splitAddressableLines(file.text)
    const firstLine = offset === undefined ? 1 : Math.max(1, Number(offset))
    const maxLines = limit === undefined ? lines.length : Math.max(0, Number(limit))
    const visibleLines = lines.slice(firstLine - 1, firstLine - 1 + maxLines)
    const snapshot = this.store.record({
      canonicalPath: file.canonicalPath,
      rootId: file.rootId,
      text: file.text,
      seenLines: asLineNumbers(firstLine, visibleLines),
      lineEnding: file.lineEnding,
      bom: file.bom,
    })
    this.readCapabilities.set(capabilityKey(inputPath, file.rootId), file.canonicalPath)
    const header = formatHeader(inputPath, snapshot.tag)
    const numbered = formatNumberedLines(visibleLines, firstLine)
    const output = numbered === "" ? header : `${header}\n${numbered}`
    return {
      path: inputPath,
      canonicalPath: file.canonicalPath,
      rootId: file.rootId,
      header,
      numbered,
      output,
      warnings: [],
      tag: snapshot.tag,
      seenLines: [...snapshot.seenLines].sort((left, right) => left - right),
    }
  }

  async edit(patch) {
    const parsed = parsePatch(patch)
    if (parsed.sections.length !== 1) {
      throw new HashlineError("multiple sections are reserved for the multi-section commit ticket")
    }

    const section = parsed.sections[0]
    const file = await this._readFile(section.path, "edit")
    const capability = this.readCapabilities.get(capabilityKey(section.path, file.rootId))
    if (capability && capability !== file.canonicalPath) {
      throw new MismatchError({
        path: section.path,
        expectedTag: section.tag,
        actualTag: computeTag(file.text),
        reason: "the read path now resolves to a different file",
      })
    }
    const { candidates, exact } = this.store.exactMatches(
      file.canonicalPath,
      file.rootId,
      section.tag,
      file.text,
    )

    if (candidates.length === 0) {
      const retained = this.store.find(file.canonicalPath, file.rootId)
      const wasRead = this.readCapabilities.has(capabilityKey(section.path, file.rootId))
      if (retained.length === 0 && !wasRead) throw new SnapshotRequiredError(section.path)
      throw new MismatchError({
        path: section.path,
        expectedTag: section.tag,
        actualTag: computeTag(file.text),
      })
    }
    if (candidates.length !== 1 || exact.length !== 1) {
      throw new MismatchError({
        path: section.path,
        expectedTag: section.tag,
        actualTag: computeTag(file.text),
      })
    }

    const snapshot = exact[0]
    const applied = applyReplacements(snapshot.text, section.hunks)
    if (applied.after === snapshot.text) throw new NoChangesError()

    const nextSnapshotInput = {
      canonicalPath: file.canonicalPath,
      rootId: file.rootId,
      text: applied.after,
      seenLines: asLineNumbers(1, splitAddressableLines(applied.after)),
      lineEnding: snapshot.lineEnding,
      bom: snapshot.bom,
    }
    this.store.assertCanRecord(nextSnapshotInput)

    let committed
    try {
      committed = await this.filesystem.writeAtomic({
        inputPath: section.path,
        baseDirectory: this.directory,
        canonicalPath: file.canonicalPath,
        rootId: file.rootId,
        expectedText: snapshot.text,
        newText: applied.after,
        lineEnding: snapshot.lineEnding,
        bom: snapshot.bom,
      })
    } catch (error) {
      throw mapFilesystemError(error, "edit", section.path)
    }

    const written = normalizeToLF(stripBom(committed.persistedText))
    const nextSnapshot = this.store.record({ ...nextSnapshotInput, text: written })
    const header = formatHeader(section.path, nextSnapshot.tag)
    const sectionResult = {
      path: section.path,
      canonicalPath: file.canonicalPath,
      op: "update",
      before: snapshot.text,
      after: applied.after,
      persisted: committed.persistedText,
      written: committed.persistedText,
      tag: nextSnapshot.tag,
      fileHash: nextSnapshot.tag,
      header,
      firstChangedLine: applied.firstChangedLine,
      warnings: [],
    }
    return {
      ...sectionResult,
      sections: [sectionResult],
      written: [file.canonicalPath],
      rolledBack: [],
      partiallyWritten: [],
    }
  }
}

export { applyReplacements }
export {
  BoundaryError,
  LineRangeError,
  MissingFileError,
  MismatchError,
  SnapshotRequiredError,
}
