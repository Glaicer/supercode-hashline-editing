import { test } from "node:test"
import assert from "node:assert/strict"

import { InMemorySnapshotStore } from "../src/snapshots.js"

function snapshot(canonicalPath, rootId, text, seenLines = []) {
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
