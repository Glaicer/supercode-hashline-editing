const SECTION_HEADER_RE = /^\[(.+)#([0-9a-fA-F]{4})\]$/
const REPLACE_RE = /^replace\s+([1-9]\d*)(?:-([1-9]\d*))?\s*$/
const INSERT_BEFORE_RE = /^insert\s+before\s+([1-9]\d*)\s*$/
const INSERT_AFTER_RE = /^insert\s+after\s+([1-9]\d*)\s*$/
const APPEND_RE = /^append\s*$/

const V1_REPLACE_ALTERNATIVE = "replace N-M or replace N"

export class PatchSyntaxError extends Error {
  constructor(message, lineNumber) {
    super(`Patch syntax error on line ${lineNumber}: ${message}`)
    this.name = "PatchSyntaxError"
    this.lineNumber = lineNumber
  }
}

function unsupportedOperation(line, lineNumber, detail = line) {
  throw new PatchSyntaxError(
    `unsupported operation/address ${JSON.stringify(detail)} in ${JSON.stringify(line)}; v1 alternative: ${V1_REPLACE_ALTERNATIVE}`,
    lineNumber,
  )
}

function parseHunkHeader(line, lineNumber) {
  const match = REPLACE_RE.exec(line)
  if (match) {
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (end < start) {
      throw new PatchSyntaxError(`replace range must end at or after line ${start}`, lineNumber)
    }
    return { operation: "replace", start, end }
  }

  const before = INSERT_BEFORE_RE.exec(line)
  if (before) return { operation: "insert", placement: "before", line: Number(before[1]) }

  const after = INSERT_AFTER_RE.exec(line)
  if (after) return { operation: "insert", placement: "after", line: Number(after[1]) }

  if (APPEND_RE.test(line)) return { operation: "insert", placement: "append" }

  if (/^PUT(?:\s|$)/.test(line)) unsupportedOperation(line, lineNumber)
  if (/\.=/.test(line)) unsupportedOperation(line, lineNumber, ".=")
  if (/^CUT(?:\s|$)/.test(line)) unsupportedOperation(line, lineNumber)
  if (/^REM(?:\s|$)/.test(line)) unsupportedOperation(line, lineNumber)
  if (/^MV(?:\s|$)/.test(line)) unsupportedOperation(line, lineNumber)
  if (/^@/.test(line)) unsupportedOperation(line, lineNumber)
  if (/^(?:replace\s+)?[1-9]\d*\*\s*$/.test(line) || /^N\*\s*$/.test(line)) {
    unsupportedOperation(line, lineNumber, "N*")
  }

  throw new PatchSyntaxError(
    `expected "replace N-M" or "replace N", got ${JSON.stringify(line)}; v1 alternative: ${V1_REPLACE_ALTERNATIVE}`,
    lineNumber,
  )
}

function parseSectionHeader(line, lineNumber) {
  const match = SECTION_HEADER_RE.exec(line)
  if (!match || match[1].trim() === "") {
    throw new PatchSyntaxError(
      `expected [PATH#TAG] with a four-hex TAG, got ${JSON.stringify(line)}`,
      lineNumber,
    )
  }
  const tag = match[2].toUpperCase()
  return {
    path: match[1],
    tag,
    header: `[${match[1]}#${tag}]`,
    hunks: [],
  }
}

/**
 * Parse the hashline patch format one line at a time.
 *
 * A hunk body is self-delimiting: every literal row starts with `+`, and the
 * first row without that prefix belongs to the next patch construct.
 */
export function parsePatch(input) {
  if (typeof input !== "string") throw new TypeError("patch must be a string")

  const lines = input.replace(/\r\n?/g, "\n").split("\n")
  const sections = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const lineNumber = index + 1
    if (line.trim() === "") {
      index += 1
      continue
    }

    const section = parseSectionHeader(line, lineNumber)
    sections.push(section)
    index += 1

    while (index < lines.length) {
      const hunkLine = lines[index]
      const hunkLineNumber = index + 1

      if (hunkLine.trim() === "") {
        index += 1
        continue
      }
      if (SECTION_HEADER_RE.test(hunkLine)) break

      const hunk = parseHunkHeader(hunkLine, hunkLineNumber)
      index += 1
      const body = []
      while (index < lines.length && lines[index].startsWith("+")) {
        body.push(lines[index].slice(1))
        index += 1
      }
      section.hunks.push({ ...hunk, body })
    }

    if (section.hunks.length === 0) {
      throw new PatchSyntaxError(`section ${section.header} has no hunks`, lineNumber)
    }
  }

  if (sections.length === 0) throw new PatchSyntaxError("patch has no sections", 1)
  return { sections }
}
