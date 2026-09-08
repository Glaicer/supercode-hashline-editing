import { test } from "node:test"
import assert from "node:assert/strict"

import { computeTag } from "./hash.ts"
import { InMemorySnapshotStore } from "./snapshots.ts"

function snapshot(canonicalPath: string, rootId: string, text: string, seenLines: number[] = []) {
  return { canonicalPath, rootId, text, seenLines, lineEnding: "lf", bom: false }
}

test("deduplicates identical content and unions seen lines", () => {
  const store = new InMemorySnapshotStore()

  const first = store.record(snapshot("/project/a.ts", "root-a", "one\ntwo", [1]))
  const second = store.record(snapshot("/project/a.ts", "root-a", "one\ntwo", [2]))

  assert.equal(first, second)
  assert.equal(store.versionCount, 1)
  assert.deepEqual([...second.seenLines].sort(), [1, 2])
  assert.equal(second.tag.length, 4)
  assert.equal(second.digest.length, 16)
})

test("normalizes CRLF and LF to one tagged Snapshot", () => {
  const store = new InMemorySnapshotStore()

  const crlf = store.record(snapshot("/project/a.ts", "root-a", "one\r\ntwo\r\n"))
  const lf = store.record(snapshot("/project/a.ts", "root-a", "one\ntwo\n"))

  assert.equal(crlf, lf)
  assert.equal(lf.text, "one\ntwo\n")
  assert.equal(lf.tag, computeTag("one\ntwo\n"))
})

test("requires an unambiguous exact Snapshot match for a colliding tag", () => {
  const store = new InMemorySnapshotStore()
  const byTag = new Map<string, string>()
  let first: string | undefined
  let second: string | undefined

  for (let index = 0; index < 100_000 && !second; index += 1) {
    const text = `collision-${index}\n`
    const tag = computeTag(text)
    const previous = byTag.get(tag)
    if (previous) {
      first = previous
      second = text
      break
    }
    byTag.set(tag, text)
  }

  assert.ok(first && second, "test data must contain a 4-hex collision")
  store.record(snapshot("/project/a.ts", "root-a", first as string, [1]))
  store.record(snapshot("/project/a.ts", "root-a", second as string, [1]))

  const exact = store.exactMatches("/project/a.ts", "root-a", computeTag(first as string), first as string)
  assert.equal(store.versionCount, 2)
  assert.equal(exact.candidates.length, 2)
  assert.equal(exact.exact.length, 1)
  assert.equal(store.resolve("/project/a.ts", "root-a", computeTag(first as string), first as string), null)
  assert.equal(store.resolve("/project/a.ts", "root-a", computeTag(first as string), "missing\n"), null)
})

test("bounds versions per path and evicts the least recently used path", () => {
  const store = new InMemorySnapshotStore({ maxPaths: 2, maxVersionsPerPath: 2 })

  store.record(snapshot("/project/a.ts", "root-a", "a-1"))
  store.record(snapshot("/project/a.ts", "root-a", "a-2"))
  store.record(snapshot("/project/a.ts", "root-a", "a-3"))
  assert.equal(store.find("/project/a.ts", "root-a").length, 2)

  store.record(snapshot("/project/b.ts", "root-a", "b"))
  store.find("/project/a.ts", "root-a")
  store.record(snapshot("/project/c.ts", "root-a", "c"))

  assert.equal(store.find("/project/a.ts", "root-a").length, 2)
  assert.equal(store.find("/project/b.ts", "root-a").length, 0)
  assert.equal(store.find("/project/c.ts", "root-a").length, 1)
})

test("enforces the total byte bound and supports invalidate/clear", () => {
  const store = new InMemorySnapshotStore({ maxTotalBytes: 5 })

  store.record(snapshot("/project/a.ts", "root-a", "1234"))
  store.record(snapshot("/project/b.ts", "root-a", "56"))

  assert.equal(store.totalBytes <= 5, true)
  assert.equal(store.find("/project/a.ts", "root-a").length, 0)

  store.invalidate("/project/b.ts", "root-a")
  assert.equal(store.versionCount, 0)
  store.record(snapshot("/project/c.ts", "root-a", "ok"))
  store.clear()
  assert.equal(store.pathCount, 0)
  assert.equal(store.versionCount, 0)
})

test("keeps the newest versions and least-recently-used paths within each limit", () => {
  const store = new InMemorySnapshotStore({ maxPaths: 2, maxVersionsPerPath: 2, maxTotalBytes: 100 })

  store.record(snapshot("/project/a.ts", "root-a", "a-1"))
  store.record(snapshot("/project/a.ts", "root-a", "a-2"))
  store.record(snapshot("/project/a.ts", "root-a", "a-3"))
  assert.deepEqual(store.find("/project/a.ts", "root-a").map(({ text }) => text), ["a-3", "a-2"])

  store.record(snapshot("/project/b.ts", "root-a", "b"))
  store.find("/project/a.ts", "root-a")
  store.record(snapshot("/project/c.ts", "root-a", "c"))
  assert.equal(store.find("/project/b.ts", "root-a").length, 0)
  assert.equal(store.pathCount, 2)
})
