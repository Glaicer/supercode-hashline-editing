import { test } from "node:test"
import assert from "node:assert/strict"

import {
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./hash.ts"
import { applyReplacements, LineRangeError } from "./service.ts"

test("applies a normalized replacement and restores BOM/CRLF bytes", () => {
  const raw = "\uFEFFone\r\ntwo\r\n"
  const normalized = normalizeToLF(stripBom(raw))
  const result = applyReplacements(normalized, [
    { operation: "replace", start: 2, end: 2, body: ["TWO"] },
  ])

  assert.equal(restoreLineEndings(result.after, "crlf", true), "\uFEFFone\r\nTWO\r\n")
})

test("does not invent a terminal newline when appending or replacing the last line", () => {
  const appended = applyReplacements("one\ntwo", [
    { operation: "insert", placement: "append", body: ["three"] },
  ])
  assert.equal(appended.after, "one\ntwo\nthree")

  const replaced = applyReplacements("one\ntwo", [
    { operation: "replace", start: 2, end: 2, body: ["TWO"] },
  ])
  assert.equal(replaced.after, "one\nTWO")
})

test("returns unchanged text for a no-op and rejects invalid ranges", () => {
  const text = "one\ntwo\n"
  const unchanged = applyReplacements(text, [
    { operation: "replace", start: 1, end: 1, body: ["one"] },
  ])
  assert.equal(unchanged.after, text)

  assert.throws(
    () => applyReplacements(text, [{ operation: "replace", start: 3, end: 3, body: ["three"] }]),
    (error: unknown) => error instanceof LineRangeError && /Line 3 does not exist \(file has 2 lines\)/.test(error.message),
  )
})
