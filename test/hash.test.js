import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeDigest,
  computeTag,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  xxHash32,
  xxHash64,
} from "../src/hash.js"

test("xxHash vectors are stable", () => {
  assert.equal(xxHash32(""), 0x02cc5d05)
  assert.equal(xxHash32("hello"), 0xfb0077f9)
  assert.equal(xxHash64(""), "EF46DB3751D8E999")
  assert.equal(xxHash64("hello"), "26C7827D889F6DA3")
})

test("tag trims only trailing horizontal whitespace while digest preserves it", () => {
  assert.equal(computeTag("a  \nvalue\t"), computeTag("a\nvalue"))
  assert.notEqual(computeDigest("a  \nvalue\t"), computeDigest("a\nvalue"))
})

test("normalizes BOM and line endings and can restore the original representation", () => {
  const raw = "\uFEFFone\r\ntwo\r\n"
  const withoutBom = stripBom(raw)
  const normalized = normalizeToLF(withoutBom)

  assert.equal(withoutBom, "one\r\ntwo\r\n")
  assert.equal(normalized, "one\ntwo\n")
  assert.equal(detectLineEnding(withoutBom), "crlf")
  assert.equal(restoreLineEndings(normalized, "crlf", true), raw)
})
