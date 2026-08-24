import path from "node:path"

import {
  computeTag,
  formatNumberedLines,
  normalizeToLF,
  restoreLineEndings,
  splitAddressableLines,
  stripBom,
} from "./hash.js"
import {
  BoundaryError,
  DuplicateHunkError,
  DuplicatePathError,
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

function uniquePaths(paths) {
  return [...new Set(paths)]
}

function makeCommitReport(paths, written = [], rolledBack = [], partiallyWritten = []) {
  const knownPaths = uniquePaths(paths)
  const forwardWritten = uniquePaths(written)
  const restored = uniquePaths(rolledBack)
  const partial = uniquePaths(partiallyWritten)
  const writtenSet = new Set(forwardWritten)
  return {
    written: forwardWritten,
    rolledBack: restored,
    partiallyWritten: partial,
    unwritten: knownPaths.filter((candidate) => !writtenSet.has(candidate)),
  }
}

function attachCommitReport(error, report, rollbackErrors = []) {
  Object.assign(error, report, { report, rollbackErrors })
  const formatPaths = (paths) => (paths.length === 0 ? "none" : paths.join(", "))
  error.message = `${error.message}; hashline commit report: written=[${formatPaths(
    report.written,
  )}], rolledBack=[${formatPaths(report.rolledBack)}], partiallyWritten=[${formatPaths(
    report.partiallyWritten,
  )}], notWritten=[${formatPaths(report.unwritten)}]`
  return error
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

  _resolveSnapshot(section, file) {
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

    return exact[0]
  }

  _prepareSection(section, file) {
    const snapshot = this._resolveSnapshot(section, file)
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
    if (applied.after === snapshot.text) throw new NoChangesError(section.path)

    const nextSnapshotInput = {
      canonicalPath: file.canonicalPath,
      rootId: file.rootId,
      text: applied.after,
      seenLines: mapSeenLinesAfterEdit(snapshot, section.hunks),
      lineEnding: snapshot.lineEnding,
      bom: snapshot.bom,
    }
    this.store.assertCanRecord(nextSnapshotInput)
    return { section, file, snapshot, applied, nextSnapshotInput }
  }

  async _discardPrepared(prepared) {
    if (typeof this.filesystem.discardPrepared !== "function") return []
    const cleanupErrors = []
    for (const item of prepared) {
      try {
        await this.filesystem.discardPrepared(item)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    return cleanupErrors
  }

  async _commitPlans(plans) {
    const paths = plans.map((plan) => plan.file.canonicalPath)
    const prepared = []

    try {
      for (const plan of plans) {
        try {
          if (typeof this.filesystem.prepareAtomic !== "function") {
            throw new HashlineError("filesystem does not support staged hashline commits")
          }
          prepared.push(
            await this.filesystem.prepareAtomic({
              inputPath: plan.section.path,
              baseDirectory: this.directory,
              canonicalPath: plan.file.canonicalPath,
              rootId: plan.file.rootId,
              expectedText: plan.snapshot.text,
              newText: plan.applied.after,
              lineEnding: plan.snapshot.lineEnding,
              bom: plan.snapshot.bom,
            }),
          )
        } catch (error) {
          throw mapFilesystemError(error, "edit", plan.section.path)
        }
      }
    } catch (error) {
      const cleanupErrors = await this._discardPrepared(prepared)
      if (cleanupErrors.length > 0) error.cleanupErrors = cleanupErrors
      throw attachCommitReport(error, makeCommitReport(paths))
    }

    const forward = []
    try {
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index]
        try {
          if (typeof this.filesystem.commitPrepared !== "function") {
            throw new HashlineError("filesystem does not support staged hashline commits")
          }
          const committed = await this.filesystem.commitPrepared(prepared[index])
          forward.push({ plan, committed })
        } catch (error) {
          const mapped = mapFilesystemError(error, "edit", plan.section.path)
          if (mapped.committed) forward.push({ plan, committed: mapped })
          throw mapped
        }
      }
    } catch (error) {
      const rolledBack = []
      const partiallyWritten = []
      const rollbackErrors = []

      for (const { plan } of forward) {
        try {
          if (typeof this.filesystem.restoreAtomic !== "function") {
            throw new HashlineError("filesystem does not support hashline rollback")
          }
          await this.filesystem.restoreAtomic({
            inputPath: plan.section.path,
            baseDirectory: this.directory,
            canonicalPath: plan.file.canonicalPath,
            rootId: plan.file.rootId,
            expectedText: plan.applied.after,
            newText: plan.snapshot.text,
            lineEnding: plan.snapshot.lineEnding,
            bom: plan.snapshot.bom,
          })
          rolledBack.push(plan.file.canonicalPath)
        } catch (rollbackError) {
          partiallyWritten.push(plan.file.canonicalPath)
          rollbackErrors.push({ path: plan.file.canonicalPath, error: rollbackError })
        }
      }

      const cleanupErrors = await this._discardPrepared(prepared)
      if (cleanupErrors.length > 0) error.cleanupErrors = cleanupErrors
      throw attachCommitReport(
        error,
        makeCommitReport(
          paths,
          forward.map(({ plan }) => plan.file.canonicalPath),
          rolledBack,
          partiallyWritten,
        ),
        rollbackErrors,
      )
    }

    const cleanupErrors = await this._discardPrepared(prepared)
    if (cleanupErrors.length > 0) {
      const cleanupError = cleanupErrors[0]
      cleanupError.cleanupErrors = cleanupErrors
      throw attachCommitReport(cleanupError, makeCommitReport(paths, paths))
    }
    try {
      const sectionResults = []
      for (const { plan, committed } of forward) {
        const persisted =
          committed?.persistedText ??
          restoreLineEndings(plan.applied.after, plan.snapshot.lineEnding, plan.snapshot.bom)
        const writtenText = normalizeToLF(stripBom(persisted))
        const nextSnapshot = this.store.record({ ...plan.nextSnapshotInput, text: writtenText })
        sectionResults.push({
          path: plan.section.path,
          canonicalPath: plan.file.canonicalPath,
          op: "update",
          before: plan.snapshot.text,
          after: plan.applied.after,
          persisted,
          written: persisted,
          tag: nextSnapshot.tag,
          fileHash: nextSnapshot.tag,
          header: formatHeader(plan.section.path, nextSnapshot.tag),
          firstChangedLine: plan.applied.firstChangedLine,
          warnings: [],
        })
      }
      return {
        sections: sectionResults,
        written: [...paths],
        rolledBack: [],
        partiallyWritten: [],
      }
    } catch (error) {
      throw attachCommitReport(error, makeCommitReport(paths, paths))
    }
  }

  async edit(patch) {
    let parsed
    try {
      parsed = parsePatch(patch)
    } catch (error) {
      throw attachCommitReport(error, makeCommitReport([]))
    }
    const sections = parsed.sections
    const resolved = []

    try {
      for (const section of sections) {
        const file = await this._readFile(section.path, "edit")
        resolved.push({ section, file })
      }

      const byCanonicalPath = new Map()
      for (const { section, file } of resolved) {
        const previous = byCanonicalPath.get(file.canonicalPath)
        if (previous) {
          throw new DuplicatePathError({
            canonicalPath: file.canonicalPath,
            paths: [previous.section.path, section.path],
          })
        }
        byCanonicalPath.set(file.canonicalPath, { section, file })
      }

      const plans = resolved.map(({ section, file }) => this._prepareSection(section, file))
      return await this._commitPlans(plans)
    } catch (error) {
      if (error.report) throw error
      const reportPaths = uniquePaths([
        ...resolved.map(({ file }) => file.canonicalPath),
        ...sections.slice(resolved.length).map((section) => section.path),
      ])
      throw attachCommitReport(error, makeCommitReport(reportPaths))
    }
  }
}

export { applyReplacements }
export {
  BoundaryError,
  DuplicatePathError,
  LineRangeError,
  MissingFileError,
  MismatchError,
  SeenLinesError,
  SnapshotRequiredError,
}
