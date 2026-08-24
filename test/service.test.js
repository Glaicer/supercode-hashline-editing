import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  BoundaryError,
  HashlineService,
  LineRangeError,
  MissingFileError,
  MismatchError,
  SnapshotRequiredError,
} from "../src/service.js"
import { computeTag } from "../src/hash.js"

let root
let outside
let service

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hashline-service-"))
  outside = await mkdtemp(path.join(tmpdir(), "hashline-service-outside-"))
  await writeFile(path.join(root, "a.ts"), "one\ntwo\nthree\n")
  await writeFile(path.join(outside, "secret.ts"), "secret\n")
  service = new HashlineService({ worktree: root, directory: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("read returns a tagged header and numbered lines, then replace returns a new snapshot header", async () => {
  const reading = await service.read("a.ts")

  assert.match(reading.header, /^\[a\.ts#[0-9A-F]{4}\]$/)
  assert.equal(reading.numbered, "1:one\n2:two\n3:three")
  assert.equal(reading.output, `${reading.header}\n${reading.numbered}`)

  const result = await service.edit(`${reading.header}\nreplace 1-2\n+ONE\n+TWO`)
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].op, "update")
  assert.equal(result.sections[0].before, "one\ntwo\nthree\n")
  assert.equal(result.sections[0].after, "ONE\nTWO\nthree\n")
  assert.equal(result.sections[0].firstChangedLine, 1)
  assert.match(result.sections[0].header, /^\[a\.ts#[0-9A-F]{4}\]$/)
  assert.equal(result.sections[0].tag, computeTag("ONE\nTWO\nthree\n"))
  assert.deepEqual(result.written, [path.join(root, "a.ts")])
  assert.deepEqual(result.rolledBack, [])
  assert.deepEqual(result.partiallyWritten, [])
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\nTWO\nthree\n")
})

test("stale content fails before writing and asks for a re-read", async () => {
  const reading = await service.read("a.ts")
  await writeFile(path.join(root, "a.ts"), "changed\ntwo\nthree\n")

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 1\n+ONE`),
    (error) => error instanceof MismatchError && /re-read/i.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "changed\ntwo\nthree\n")
})

test("edit requires a Snapshot minted by read", async () => {
  await assert.rejects(
    service.edit("[a.ts#AAAA]\nreplace 1\n+ONE"),
    (error) => error instanceof SnapshotRequiredError && /read/i.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("edit refuses missing files and points to the native write tool", async () => {
  await assert.rejects(
    service.edit("[missing.ts#AAAA]\nreplace 1\n+never"),
    (error) => error instanceof MissingFileError && /native write/i.test(error.message),
  )
})

test("invalid ranges fail before writing with the file line count", async () => {
  const reading = await service.read("a.ts")

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 999\n+never`),
    (error) => error instanceof LineRangeError && /Line 999 does not exist \(file has 3 lines\)/.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("boundary failures do not reveal or write files outside the root", async () => {
  await assert.rejects(service.read("../secret.ts"), (error) => error instanceof BoundaryError)
  await assert.rejects(service.read(path.join(outside, "secret.ts")), (error) => error instanceof BoundaryError)

  await symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"))
  await assert.rejects(service.read("link.ts"), (error) => error instanceof BoundaryError)
  assert.equal(await readFile(path.join(outside, "secret.ts"), "utf8"), "secret\n")
})

test("retargeting a link between read and edit is rejected", async () => {
  const link = path.join(root, "link.ts")
  await symlink(path.join(root, "a.ts"), link)
  const reading = await service.read("link.ts")

  await rm(link)
  await symlink(path.join(outside, "secret.ts"), link)

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 1\n+NOPE`),
    (error) => error instanceof BoundaryError,
  )
  assert.equal(await readFile(path.join(outside, "secret.ts"), "utf8"), "secret\n")
})

test("a 4-hex tag collision is a mismatch instead of a version choice", async () => {
  const byTag = new Map()
  let first
  let second
  for (let index = 0; index < 100_000 && !second; index += 1) {
    const text = `collision-${index}\n`
    const tag = computeTag(text)
    const previous = byTag.get(tag)
    if (previous && previous !== text) {
      first = previous
      second = text
      break
    }
    byTag.set(tag, text)
  }
  assert.ok(first && second, "test data must contain a 4-hex collision")

  await writeFile(path.join(root, "a.ts"), first)
  const reading = await service.read("a.ts")
  service.store.record({
    canonicalPath: path.join(root, "a.ts"),
    rootId: path.resolve(root),
    text: second,
    seenLines: [1],
    lineEnding: "lf",
    bom: false,
  })

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 1\n+unsafe`),
    (error) => error instanceof MismatchError,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), first)
})

test("a Snapshot from another rootId cannot authorize an edit", async () => {
  const reading = await service.read("a.ts")
  service.store.clear()
  service.store.record({
    canonicalPath: path.join(root, "a.ts"),
    rootId: "foreign-root",
    text: "one\ntwo\nthree\n",
    seenLines: [1, 2, 3],
    lineEnding: "lf",
    bom: false,
  })

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 1\n+unsafe`),
    (error) => error instanceof SnapshotRequiredError,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("preserves a file's BOM and CRLF representation through replace", async () => {
  await writeFile(path.join(root, "a.ts"), "\uFEFFone\r\ntwo\r\n", "utf8")
  const reading = await service.read("a.ts")

  assert.equal(reading.numbered, "1:one\n2:two")
  await service.edit(`${reading.header}\nreplace 2\n+TWO`)

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "\uFEFFone\r\nTWO\r\n")
})
