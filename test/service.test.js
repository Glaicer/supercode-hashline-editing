import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  BoundaryError,
  DuplicatePathError,
  HashlineService,
  LineRangeError,
  MissingFileError,
  MismatchError,
  NoChangesError,
  SeenLinesError,
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

test("applies insert before, insert after, and append using original line numbers", async () => {
  const reading = await service.read("a.ts")

  const result = await service.edit([
    reading.header,
    "insert before 1",
    "+zero",
    "insert after 2",
    "+between",
    "append",
    "+four",
  ].join("\n"))

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "zero\none\ntwo\nbetween\nthree\nfour\n")
  assert.equal(result.sections[0].firstChangedLine, 1)
})

test("insert before 1 can add the first line to an empty file", async () => {
  await writeFile(path.join(root, "a.ts"), "")
  const reading = await service.read("a.ts")

  const result = await service.edit(`${reading.header}\ninsert before 1\n+head`)

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "head")
  assert.equal(result.sections[0].firstChangedLine, 1)
})

test("insert bodies use the same literal prefix rules as replacements", async () => {
  const reading = await service.read("a.ts")

  await service.edit([
    reading.header,
    "insert before 2",
    "+- item",
    "++ item",
    "+",
  ].join("\n"))

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\n- item\n+ item\n\ntwo\nthree\n")
})

test("windowed reads union the shown lines into one tagged snapshot", async () => {
  const first = await service.read("a.ts", 1, 1)
  const second = await service.read("a.ts", 1, 3)

  assert.equal(first.numbered, "1:one")
  assert.equal(second.numbered, "3:three")
  assert.equal(first.tag, second.tag)
  assert.deepEqual(second.seenLines, [1, 3])
})

test("unseen anchors reveal a bounded preview and allow a retry when complete", async () => {
  await writeFile(path.join(root, "a.ts"), Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n") + "\n")
  const reading = await service.read("a.ts", 2)
  const patch = `${reading.header}\nreplace 9\n+changed`

  await assert.rejects(service.edit(patch), (error) => {
    assert.ok(error instanceof SeenLinesError)
    assert.deepEqual(error.revealed, [{ line: 9, text: "line-9" }])
    assert.equal(error.truncated, false)
    return true
  })

  const result = await service.edit(patch)
  assert.equal(result.sections[0].firstChangedLine, 9)
  assert.equal((await readFile(path.join(root, "a.ts"), "utf8")).split("\n")[8], "changed")
})

test("long or over-cap previews stay truncated and do not authorize a retry", async () => {
  const longLine = "x".repeat(513)
  await writeFile(path.join(root, "a.ts"), `one\n${longLine}\nthree\n`)
  const reading = await service.read("a.ts", 1)
  const patch = `${reading.header}\nreplace 2\n+changed`

  await assert.rejects(service.edit(patch), (error) => {
    assert.ok(error instanceof SeenLinesError)
    assert.equal(error.truncated, true)
    assert.equal(error.revealed[0].text.length, 512)
    assert.equal(error.revealed[0].text.at(-1), "…")
    return true
  })
  await assert.rejects(service.edit(patch), (error) => error instanceof SeenLinesError)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), `one\n${longLine}\nthree\n`)
})

test("reveal previews cap at forty missing lines", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n") + "\n",
  )
  const reading = await service.read("a.ts", 1)
  const patch = `${reading.header}\nreplace 2-42\n+changed`

  await assert.rejects(service.edit(patch), (error) => {
    assert.ok(error instanceof SeenLinesError)
    assert.equal(error.revealed.length, 40)
    assert.equal(error.revealed[0].line, 2)
    assert.equal(error.revealed.at(-1).line, 41)
    assert.equal(error.truncated, true)
    return true
  })
  await assert.rejects(service.edit(patch), (error) => error instanceof SeenLinesError)
})

test("enforceSeenLines false leaves snapshot freshness checks enabled but skips the visibility guard", async () => {
  const unenforced = new HashlineService({ worktree: root, directory: root, enforceSeenLines: false })
  const reading = await unenforced.read("a.ts", 1)

  await unenforced.edit(`${reading.header}\nreplace 3\n+THREE`)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nTHREE\n")
})

test("a new tag keeps the prior snapshot visibility after an edit", async () => {
  const reading = await service.read("a.ts", 1)
  const result = await service.edit(`${reading.header}\nreplace 1\n+ONE`)
  const nextHeader = result.sections[0].header

  await assert.rejects(
    service.edit(`${nextHeader}\nreplace 3\n+THREE`),
    (error) => error instanceof SeenLinesError,
  )
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

test("multi-section preflight rejects a stale later file before writing the first", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\nbeta\n")
  const aReading = await service.read("a.ts")
  const bReading = await service.read("b.ts")
  await writeFile(path.join(root, "b.ts"), "changed\nbeta\n")

  await assert.rejects(
    service.edit(
      [
        aReading.header,
        "replace 1",
        "+ONE",
        bReading.header,
        "replace 1",
        "+ALPHA",
      ].join("\n"),
    ),
    (error) => {
      assert.equal(error.path, "b.ts")
      assert.deepEqual(error.written, [])
      assert.deepEqual(error.rolledBack, [])
      assert.deepEqual(error.partiallyWritten, [])
      return true
    },
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("multi-section preflight rejects duplicate canonical paths", async () => {
  const link = path.join(root, "link.ts")
  await symlink(path.join(root, "a.ts"), link)
  const aReading = await service.read("a.ts")
  const linkReading = await service.read("link.ts")

  await assert.rejects(
    service.edit(
      [
        aReading.header,
        "replace 1",
        "+ONE",
        linkReading.header,
        "replace 2",
        "+TWO",
      ].join("\n"),
    ),
    (error) => {
      assert.ok(error instanceof DuplicatePathError)
      assert.equal(error.canonicalPath, path.join(root, "a.ts"))
      assert.deepEqual(error.written, [])
      return true
    },
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("syntax failures still carry an empty commit report", async () => {
  await assert.rejects(
    service.edit("not a hashline patch"),
    (error) => {
      assert.deepEqual(error.written, [])
      assert.deepEqual(error.rolledBack, [])
      assert.deepEqual(error.partiallyWritten, [])
      return true
    },
  )
})

test("edit requires a Snapshot minted by read", async () => {
  await assert.rejects(
    service.edit("[a.ts#AAAA]\nreplace 1\n+ONE"),
    (error) => error instanceof SnapshotRequiredError && /read/i.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("a section without a tag asks for read before edit", async () => {
  await assert.rejects(
    service.edit("[a.ts]\nreplace 1\n+ONE"),
    (error) => error instanceof SnapshotRequiredError && !(error instanceof MismatchError) && /read first/i.test(error.message),
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

test("retargeting a link to another in-root file cannot rebind the capability", async () => {
  const link = path.join(root, "link.ts")
  await writeFile(path.join(root, "b.ts"), "one\ntwo\nthree\n")
  await symlink(path.join(root, "a.ts"), link)
  const reading = await service.read("link.ts")
  await service.read("b.ts")

  await rm(link)
  await symlink(path.join(root, "b.ts"), link)

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 1\n+NOPE`),
    (error) => error instanceof MismatchError && /different file/i.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "one\ntwo\nthree\n")
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
    (error) => error instanceof MismatchError,
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

test("rejects a patch that leaves normalized text unchanged", async () => {
  const reading = await service.read("a.ts")
  const original = await readFile(path.join(root, "a.ts"), "utf8")

  await assert.rejects(
    service.edit(`${reading.header}\nreplace 1\n+one`),
    (error) => error instanceof NoChangesError && /resulted in no changes/.test(error.message),
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), original)
  assert.equal((await service.read("a.ts")).tag, reading.tag)
})

test("restores the dominant line ending for a mixed-line-ending file", async () => {
  await writeFile(path.join(root, "a.ts"), "one\r\ntwo\nthree\n", "utf8")
  const reading = await service.read("a.ts")

  await service.edit(`${reading.header}\nreplace 2\n+TWO`)

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\nTWO\nthree\n")
})

test("keeps a missing terminal newline through append and last-line replace", async () => {
  await writeFile(path.join(root, "a.ts"), "one\ntwo", "utf8")
  const reading = await service.read("a.ts")

  const appended = await service.edit(`${reading.header}\nappend\n+three`)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree")

  await service.edit(`${appended.sections[0].header}\nreplace 3\n+THREE`)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nTHREE")
})

test("capacity failure happens before the file write", async () => {
  const constrained = new HashlineService({ worktree: root, directory: root, maxTotalBytes: 14 })
  const reading = await constrained.read("a.ts")

  await assert.rejects(constrained.edit(`${reading.header}\nreplace 1\n+this is too large`), /Snapshot.*limit/)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\nthree\n")
})

test("an evicted tag is a mismatch that requires re-read", async () => {
  const constrained = new HashlineService({ worktree: root, directory: root, maxVersionsPerPath: 1 })
  const first = await constrained.read("a.ts")
  await writeFile(path.join(root, "a.ts"), "new\ntwo\nthree\n")
  await constrained.read("a.ts")

  await assert.rejects(
    constrained.edit(`${first.header}\nreplace 1\n+unsafe`),
    (error) => error instanceof MismatchError && /re-read/i.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "new\ntwo\nthree\n")
})
