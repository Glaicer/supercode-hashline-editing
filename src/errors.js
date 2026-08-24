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
  constructor({ path, expectedTag, actualTag }) {
    super(
      `Snapshot mismatch for ${path}: section uses #${expectedTag}, live file is #${actualTag}; re-read the file and retry`,
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

export class NoChangesError extends HashlineError {
  constructor() {
    super("edit resulted in no changes")
    this.name = "NoChangesError"
  }
}

export class MissingFileError extends HashlineError {
  constructor(path) {
    super(`Hashline edits only existing files; use the native write tool to create ${path}`)
    this.name = "MissingFileError"
    this.path = path
  }
}

