export class HashlineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HashlineError"
  }
}

export class BoundaryError extends HashlineError {
  path?: string
  roots?: string[]
  constructor(path?: string, roots?: string[]) {
    super(
      path
        ? `Path ${path} is outside the Snapshot Root${roots?.length ? ` (roots: ${roots.join(", ")})` : ""}; hashline edit is unavailable for ${path}`
        : "Path is outside the Snapshot Root",
    )
    this.name = "BoundaryError"
    this.path = path
    this.roots = roots
  }
}

export interface MismatchDetails {
  path: string
  expectedTag: string
  actualTag: string
  reason?: string
  liveLineCount?: number
}

export class MismatchError extends HashlineError {
  path: string
  expectedTag: string
  actualTag: string
  constructor({ path, expectedTag, actualTag, reason, liveLineCount }: MismatchDetails) {
    const details = [liveLineCount === undefined ? undefined : `${liveLineCount} lines`, reason]
      .filter((part) => part !== undefined)
      .join("; ")
    super(
      `Snapshot mismatch for ${path}: section uses #${expectedTag}, live file is #${actualTag}${
        details ? ` (${details})` : ""
      }. If your line numbers still apply, retry with this header: [${path}#${actualTag}]; if the file shifted, re-read around your hunks`,
    )
    this.name = "MismatchError"
    this.path = path
    this.expectedTag = expectedTag
    this.actualTag = actualTag
  }
}

export class SnapshotRequiredError extends HashlineError {
  path: string
  readHeader?: string
  constructor(path: string, readHeader?: string) {
    super(readHeader
      ? `Path spelling mismatch for ${path}; this file was read using a different path spelling. Use this read header verbatim:\n${readHeader}\nRetry with this exact header; do not shorten or normalize PATH or reconstruct TAG.`
      : `No live Snapshot exists for ${path}; call read first, then copy its entire [PATH#TAG] header verbatim. Snapshots are in-memory and were reset after a restart or location switch.`)
    this.name = "SnapshotRequiredError"
    this.path = path
    this.readHeader = readHeader
  }
}

export class LineRangeError extends HashlineError {
  line: number
  lineCount: number
  constructor(line: number, lineCount: number) {
    super(`Line ${line} does not exist (file has ${lineCount} lines)`)
    this.name = "LineRangeError"
    this.line = line
    this.lineCount = lineCount
  }
}

export class DuplicateHunkError extends HashlineError {
  constructor() {
    super("Overlapping replace ranges are not allowed")
    this.name = "DuplicateHunkError"
  }
}

export interface DuplicatePathDetails {
  canonicalPath: string
  paths: string[]
}

export class DuplicatePathError extends HashlineError {
  canonicalPath: string
  paths: string[]
  constructor({ canonicalPath, paths }: DuplicatePathDetails) {
    super(
      `Multiple patch sections resolve to the same canonical path ${canonicalPath}: ${paths.join(
        ", ",
      )}`,
    )
    this.name = "DuplicatePathError"
    this.canonicalPath = canonicalPath
    this.paths = paths
  }
}

export class NoChangesError extends HashlineError {
  constructor(path?: string) {
    super(path ? `edit for ${path} resulted in no changes` : "edit resulted in no changes")
    this.name = "NoChangesError"
  }
}

export interface SeenLine {
  line: number
  text: string
}

export interface SeenLinesDetails {
  path: string
  missingLines: number[]
  revealed: SeenLine[]
  truncated: boolean
}

export class SeenLinesError extends HashlineError {
  path: string
  missingLines: number[]
  revealed: SeenLine[]
  truncated: boolean
  constructor({ path, missingLines, revealed, truncated }: SeenLinesDetails) {
    const preview = revealed.map(({ line, text }) => `${line}:${text}`).join("\n")
    super(
      truncated
        ? `SeenLines guard rejected an edit for ${path}\n${preview}\nRe-read the missing lines with offset ${missingLines[0]} and retry`
        : `SeenLines guard rejected an edit for ${path}\n${preview}\nThe missing lines are shown above; retry the edit now with the same header — no re-read needed`,
    )
    this.name = "SeenLinesError"
    this.path = path
    this.missingLines = missingLines
    this.revealed = revealed
    this.truncated = truncated
  }
}

export class MissingFileError extends HashlineError {
  path: string
  constructor(path: string) {
    super(`Hashline edits only existing files; use the native write tool to create ${path}`)
    this.name = "MissingFileError"
    this.path = path
  }
}
