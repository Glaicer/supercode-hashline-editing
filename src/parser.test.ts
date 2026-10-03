import { test } from "node:test"
import assert from "node:assert/strict"

import { SnapshotRequiredError } from "./errors.ts"
import { parsePatch, PatchSyntaxError } from "./parser.ts"

test("parses replace ranges and strips exactly one body prefix", () => {
  const patch = [
    "[src/a.ts#A1B2]",
    "replace 2-4",
    "+line",
    "++literal plus",
    "+-literal minus",
    "+replace 1-2",
    "+[x#ABCD]",
    "",
    "replace 8",
    "+single",
  ].join("\n")

  assert.deepEqual(parsePatch(patch), {
    sections: [
      {
        path: "src/a.ts",
        tag: "A1B2",
        header: "[src/a.ts#A1B2]",
        hunks: [
          {
            operation: "replace",
            start: 2,
            end: 4,
            body: ["line", "+literal plus", "-literal minus", "replace 1-2", "[x#ABCD]"],
          },
          { operation: "replace", start: 8, end: 8, body: ["single"] },
        ],
      },
    ],
    warnings: [],
  })
})

test("parses multiple sections without treating headers as body syntax", () => {
  const result = parsePatch("[a.ts#AAAA]\nreplace 1\n+one\n\n[b.ts#BBBB]\nreplace 1-2\n+two")

  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[1].path, "b.ts")
  assert.deepEqual(result.sections[1].hunks[0].body, ["two"])
})

test("parses insert anchors and append", () => {
  const result = parsePatch([
    "[a.ts#AAAA]",
    "insert before 1",
    "+head",
    "insert after 2",
    "+tail",
    "append",
    "+end",
  ].join("\n"))

  assert.deepEqual(result.sections[0].hunks, [
    { operation: "insert", placement: "before", line: 1, body: ["head"] },
    { operation: "insert", placement: "after", line: 2, body: ["tail"] },
    { operation: "insert", placement: "append", body: ["end"] },
  ])
})

test("reports an address-specific v1 alternative for unsupported operations", () => {
  const unsupported = [
    ["PUT 1", "replace N-M or replace N"],
    [".= 1-2", "replace N-M"],
    ["CUT 1", "replace N-M"],
    ["@name", "replace N-M"],
    ["N*", "replace N-M"],
    ["replace 1*", "replace N-M"],
    ["REM", "replace N-M"],
    ["MV other.ts", "replace N-M"],
  ]

  for (const [operation, alternative] of unsupported) {
    assert.throws(
      () => parsePatch(`[a.ts#AAAA]\n${operation}`),
      (error: unknown) => {
        assert.ok(error instanceof PatchSyntaxError)
        const syntaxError = error as PatchSyntaxError
        assert.match(syntaxError.message, new RegExp(operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        assert.match(syntaxError.message, new RegExp(alternative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        return true
      },
    )
  }
})

test("a leaked body-row '+' before an unsupported op reports the specific message", () => {
  assert.throws(
    () => parsePatch("[a.ts#AAAA]\n+PUT 3"),
    (error: unknown) => {
      assert.ok(error instanceof PatchSyntaxError)
      assert.match(error.message, /Oh My Pi syntax not supported/)
      return true
    },
  )
})

test("reports a missing tag for a later section instead of parsing it as a hunk", () => {
  assert.throws(
    () => parsePatch("[a.ts#AAAA]\nreplace 1\n+one\n[b.ts]\nreplace 1\n+two"),
    (error: unknown) => error instanceof SnapshotRequiredError && /b\.ts/.test(error.message) && /read/i.test(error.message),
  )
})

test("accepts one leading '+' before a hunk header and records a warning", () => {
  const result = parsePatch("[a.ts#AAAA]\n+replace 1-2\n+one")

  assert.deepEqual(result.sections[0].hunks, [
    { operation: "replace", start: 1, end: 2, body: ["one"] },
  ])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /line 2: removed the leading '\+' from the hunk header "\+replace 1-2"/)
})

test("accepts '+replace N' at hunk position and records a warning", () => {
  const result = parsePatch("[a.ts#AAAA]\n+replace 3\n+TWO")

  assert.deepEqual(result.sections[0].hunks, [
    { operation: "replace", start: 3, end: 3, body: ["TWO"] },
  ])
  assert.equal(result.warnings.length, 1)
})

test("accepts an @@-wrapped hunk header and records a warning", () => {
  const result = parsePatch("[a.ts#AAAA]\n@@insert before 7@@\n+head")

  assert.deepEqual(result.sections[0].hunks, [
    { operation: "insert", placement: "before", line: 7, body: ["head"] },
  ])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /line 2: removed the '@@' wrapper around the hunk header "@@insert before 7@@"$/)
})

test("splits a hunk carried on the section header line and records a warning", () => {
  const result = parsePatch("[a.ts#AAAA] insert after 3\n+tail")

  assert.deepEqual(result.sections[0].hunks, [
    { operation: "insert", placement: "after", line: 3, body: ["tail"] },
  ])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /line 1: moved the hunk header "insert after 3" off the section header line$/)
})

test("a later section header may carry its hunk on the same line", () => {
  const result = parsePatch("[a.ts#AAAA]\nreplace 1\n+one\n[b.ts#BBBB] replace 1\n+two")

  assert.equal(result.sections.length, 2)
  assert.deepEqual(result.sections[1].hunks, [
    { operation: "replace", start: 1, end: 1, body: ["two"] },
  ])
  assert.equal(result.warnings.length, 1)
})

test("invented tags stay rejected with recovery guidance", () => {
  assert.throws(
    () => parsePatch("[src/a.ts#PLACEHOLDER]\nreplace 1\n+one"),
    (error: unknown) => {
      assert.ok(error instanceof PatchSyntaxError)
      assert.match(error.message, /four-hex TAG/)
      assert.match(error.message, /call read and copy its header/)
      assert.match(error.message, /invented tags are always rejected/)
      return true
    },
  )
})

test("a patch without any section header stays rejected with recovery guidance", () => {
  assert.throws(
    () => parsePatch("replace 1\n+one"),
    (error: unknown) => {
      assert.ok(error instanceof PatchSyntaxError)
      assert.match(error.message, /call read and copy its header/)
      assert.match(error.message, /invented tags are always rejected/)
      return true
    },
  )
})

test("a nonsense hunk line stays rejected with recovery guidance", () => {
  assert.throws(
    () => parsePatch("[a.ts#AAAA]\nwobble 1-2"),
    (error: unknown) => {
      assert.ok(error instanceof PatchSyntaxError)
      assert.match(error.message, /v1 alternative: replace N-M or replace N/)
      assert.match(error.message, /call read and copy its header/)
      return true
    },
  )
})

test("ambiguous distortions stay rejected", () => {
  for (const line of ["+wobble", "@@PUT 1@@", "++replace 1", "[a.ts#AAAA] PUT 1"]) {
    assert.throws(() => parsePatch(`[a.ts#AAAA]\n${line}`), PatchSyntaxError)
  }
})
