export class HashlineError extends Error {
  constructor(message) {
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

export class MismatchError extends HashlineError {
  constructor({ path, expectedTag, actualTag, reason }) {
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
  constructor(path) {
    super(`No live Snapshot exists for ${path}; call read first, then edit using its header`)
    this.name = "SnapshotRequiredError"
    this.path = path
  }
}

export class LineRangeError extends HashlineError {
  constructor(line, lineCount) {
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

export class DuplicatePathError extends HashlineError {
  constructor({ canonicalPath, paths }) {
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
  constructor(path) {
    super(path ? `edit for ${path} resulted in no changes` : "edit resulted in no changes")
    this.name = "NoChangesError"
  }
}

export class SeenLinesError extends HashlineError {
  constructor({ path, missingLines, revealed, truncated }) {
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
  constructor(path) {
    super(`Hashline edits only existing files; use the native write tool to create ${path}`)
    this.name = "MissingFileError"
    this.path = path
  }
}
