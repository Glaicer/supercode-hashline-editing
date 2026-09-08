export class HashlineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HashlineError"
  }
}

export class BoundaryError extends HashlineError {
  constructor() {
    super("Path is outside the Snapshot Root")
    this.name = "BoundaryError"
  }
}

export interface MismatchDetails {
  path: string
  expectedTag: string
  actualTag: string
  reason?: string
}

export class MismatchError extends HashlineError {
  path: string
  expectedTag: string
  actualTag: string
  constructor({ path, expectedTag, actualTag, reason }: MismatchDetails) {
    super(
      `Snapshot mismatch for ${path}: section uses #${expectedTag}, live file is #${actualTag}${
        reason ? ` (${reason})` : ""
      }; re-read the file and retry`,
    )
    this.name = "MismatchError"
    this.path = path
    this.expectedTag = expectedTag
    this.actualTag = actualTag
  }
}

export class SnapshotRequiredError extends HashlineError {
  path: string
  constructor(path: string) {
    super(`No live Snapshot exists for ${path}; call read first, then edit using its header`)
    this.name = "SnapshotRequiredError"
    this.path = path
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
      `SeenLines guard rejected an edit for ${path}; re-read the missing lines and retry${
        preview ? `\n${preview}` : ""
      }`,
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
