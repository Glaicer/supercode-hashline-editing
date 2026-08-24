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
  SeenLinesError,
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

export const SEEN_LINE_REVEAL_CAP = 40
export const SEEN_LINE_REVEAL_MAX_COLUMNS = 512

function validateHunks(lines, hunks) {
  const lineCount = lines.length

  for (const hunk of hunks) {
    if (hunk.operation === "replace") {
      if (hunk.start < 1 || hunk.end > lineCount) {
        const missingLine = hunk.start > lineCount ? hunk.start : hunk.end
        throw new LineRangeError(missingLine, lineCount)
      }
      continue
    }

    if (hunk.operation === "insert" && hunk.placement === "before") {
      if (hunk.line !== 1 && (hunk.line < 1 || hunk.line > lineCount)) {
        throw new LineRangeError(hunk.line, lineCount)
      }
      continue
    }

    if (hunk.operation === "insert" && hunk.placement === "after") {
      if (hunk.line < 1 || hunk.line > lineCount) throw new LineRangeError(hunk.line, lineCount)
    }
  }

  const replacements = hunks
    .filter((hunk) => hunk.operation === "replace")
    .sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].start <= replacements[index - 1].end) throw new DuplicateHunkError()
  }

  return { lineCount, replacements }
}

function appendHunks(target, hunks) {
  for (const hunk of hunks) target.push(...hunk.body)
}

function indexHunks(hunks, replacements) {
  const replacementByStart = new Map(replacements.map((hunk) => [hunk.start, hunk]))
  const before = new Map()
  const after = new Map()
  const append = []

  for (const hunk of hunks) {
    if (hunk.operation !== "insert") continue
    if (hunk.placement === "append") {
      append.push(hunk)
      continue
    }
    const destination = hunk.placement === "before" ? before : after
    const existing = destination.get(hunk.line) ?? []
    existing.push(hunk)
    destination.set(hunk.line, existing)
  }

  return { replacementByStart, before, after, append }
}

function changedLineForHunk(hunk, lineCount) {
  if (hunk.operation === "replace") return hunk.start
  if (hunk.placement === "before") return hunk.line
  if (hunk.placement === "after") return hunk.line + 1
  return lineCount + 1
}

function applyReplacements(text, hunks) {
  const lines = splitAddressableLines(text)
  const { lineCount, replacements } = validateHunks(lines, hunks)
  const { replacementByStart, before, after: afterLines, append } = indexHunks(hunks, replacements)

  const hadTerminalNewline = text.endsWith("\n")
  const result = []
  let replacedThrough = 0
  if (lineCount === 0) appendHunks(result, before.get(1) ?? [])
  for (let line = 1; line <= lineCount; line += 1) {
    appendHunks(result, before.get(line) ?? [])

    const replacement = replacementByStart.get(line)
    if (replacement) {
      result.push(...replacement.body)
      replacedThrough = replacement.end
    } else if (line > replacedThrough) {
      result.push(lines[line - 1])
    }

    appendHunks(result, afterLines.get(line) ?? [])
  }

  appendHunks(result, append)
  const after = result.join("\n") + (hadTerminalNewline ? "\n" : "")
  const firstChangedLine = hunks.reduce(
    (first, hunk) => Math.min(first, changedLineForHunk(hunk, lineCount)),
    Number.POSITIVE_INFINITY,
  )
  return {
    after,
    firstChangedLine: Number.isFinite(firstChangedLine) ? firstChangedLine : undefined,
  }
}

function recordHunkLines(seenLines, hunks, outputLine) {
  for (const hunk of hunks) {
    for (let index = 0; index < hunk.body.length; index += 1) seenLines.add(outputLine + index)
    outputLine += hunk.body.length
  }
  return outputLine
}

function mapSeenLinesAfterEdit(snapshot, hunks) {
  const lines = splitAddressableLines(snapshot.text)
  const { lineCount, replacements } = validateHunks(lines, hunks)
  const { replacementByStart, before, after: afterLines, append } = indexHunks(hunks, replacements)
  const seenLines = new Set()
  let outputLine = 1
  let replacedThrough = 0
  if (lineCount === 0) outputLine = recordHunkLines(seenLines, before.get(1) ?? [], outputLine)

  for (let line = 1; line <= lineCount; line += 1) {
    outputLine = recordHunkLines(seenLines, before.get(line) ?? [], outputLine)

    const replacement = replacementByStart.get(line)
    if (replacement) {
      outputLine = recordHunkLines(seenLines, [replacement], outputLine)
      replacedThrough = replacement.end
    } else if (line > replacedThrough) {
      if (snapshot.seenLines.has(line)) seenLines.add(outputLine)
      outputLine += 1
    }

    outputLine = recordHunkLines(seenLines, afterLines.get(line) ?? [], outputLine)
  }

  recordHunkLines(seenLines, append, outputLine)
  return seenLines
}

function addressedLines(hunks, lineCount) {
  const lines = new Set()
  for (const hunk of hunks) {
    if (hunk.operation === "replace") {
      for (let line = hunk.start; line <= hunk.end; line += 1) lines.add(line)
    } else if (hunk.operation === "insert" && hunk.placement !== "append") {
      lines.add(hunk.line)
    }
  }
  return [...lines].filter((line) => line >= 1 && line <= lineCount).sort((left, right) => left - right)
}

function revealLines(snapshot, missingLines) {
  const lines = splitAddressableLines(snapshot.text)
  let truncated = missingLines.length > SEEN_LINE_REVEAL_CAP
  const revealed = missingLines.slice(0, SEEN_LINE_REVEAL_CAP).map((line) => {
    const text = lines[line - 1]
    if (text.length > SEEN_LINE_REVEAL_MAX_COLUMNS) {
      truncated = true
      return {
        line,
        text: `${text.slice(0, SEEN_LINE_REVEAL_MAX_COLUMNS - 1)}…`,
      }
    }
    return { line, text }
  })
  return { revealed, truncated }
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
    enforceSeenLines = true,
  }) {
    if (!worktree) throw new TypeError("worktree is required")
    this.worktree = path.resolve(worktree)
    this.directory = path.resolve(directory)
    this.enforceSeenLines = enforceSeenLines
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
    const lines = splitAddressableLines(snapshot.text)
    validateHunks(lines, section.hunks)
    if (this.enforceSeenLines) {
      const addressed = addressedLines(section.hunks, lines.length)
      const missingLines = addressed.filter((line) => !snapshot.seenLines.has(line))
      if (missingLines.length > 0) {
        const reveal = revealLines(snapshot, missingLines)
        if (!reveal.truncated) {
          for (const { line } of reveal.revealed) snapshot.seenLines.add(line)
        }
        throw new SeenLinesError({
          path: section.path,
          missingLines,
          revealed: reveal.revealed,
          truncated: reveal.truncated,
        })
      }
    }
    const applied = applyReplacements(snapshot.text, section.hunks)
    if (applied.after === snapshot.text) throw new NoChangesError()

    const nextSnapshotInput = {
      canonicalPath: file.canonicalPath,
      rootId: file.rootId,
      text: applied.after,
      seenLines: mapSeenLinesAfterEdit(snapshot, section.hunks),
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
  SeenLinesError,
  SnapshotRequiredError,
}
