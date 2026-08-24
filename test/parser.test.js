import { test } from "node:test"
import assert from "node:assert/strict"

import { parsePatch, PatchSyntaxError } from "../src/parser.js"

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
  })
})

test("parses multiple sections without treating headers as body syntax", () => {
  const result = parsePatch("[a.ts#AAAA]\nreplace 1\n+one\n\n[b.ts#BBBB]\nreplace 1-2\n+two")

  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[1].path, "b.ts")
  assert.deepEqual(result.sections[1].hunks[0].body, ["two"])
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
      (error) => {
        assert.ok(error instanceof PatchSyntaxError)
        assert.match(error.message, new RegExp(operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        assert.match(error.message, new RegExp(alternative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        return true
      },
    )
  }
})
