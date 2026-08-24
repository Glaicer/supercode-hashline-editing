import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import HashlinePlugin, { createHashlineHooks } from "../plugin/hashline.js"
import { computeTag } from "../src/hash.js"
import { InMemorySnapshotStore } from "../src/snapshots.js"

let root
let outside

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hashline-plugin-"))
  outside = await mkdtemp(path.join(tmpdir(), "hashline-plugin-outside-"))
  await writeFile(path.join(root, "a.ts"), "one\ntwo\n")
  await writeFile(path.join(outside, "secret.ts"), "secret\n")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("registers built-in read/edit names and runs read to edit end-to-end", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })

  assert.deepEqual(Object.keys(hooks.tool).sort(), ["edit", "read"])
  const reading = await hooks.tool.read.execute({ path: "a.ts" }, {})
  assert.match(reading.output, /^\[a\.ts#[0-9A-F]{4}\]\n1:one\n2:two$/)

  const header = reading.output.split("\n")[0]
  const editing = await hooks.tool.edit.execute(
    { patch: `${header}\nreplace 1\n+ONE` },
    {},
  )
  assert.match(editing.output, /\[a\.ts#[0-9A-F]{4}\]/)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\n")
})

test("plugin seam rejects stale edits and edits without a prior read", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const reading = await hooks.tool.read.execute({ path: "a.ts" }, {})

  await writeFile(path.join(root, "a.ts"), "changed\ntwo\n")
  await assert.rejects(
    hooks.tool.edit.execute({ patch: `${reading.output.split("\n")[0]}\nreplace 1\n+ONE` }, {}),
    /re-read/i,
  )

  await writeFile(path.join(root, "b.ts"), "one\ntwo\n")
  const freshHooks = await HashlinePlugin({ worktree: root, directory: root })
  await assert.rejects(
    freshHooks.tool.edit.execute({ patch: "[b.ts#AAAA]\nreplace 1\n+ONE" }, {}),
    /read first/i,
  )
})

test("plugin forwards enforceSeenLines to the service", async () => {
  const hooks = await HashlinePlugin(
    { worktree: root, directory: root },
    { enforceSeenLines: false },
  )
  const reading = await hooks.tool.read.execute({ path: "a.ts", limit: 1 }, {})

  await hooks.tool.edit.execute(
    { patch: `${reading.output.split("\n")[0]}\nreplace 2\n+TWO` },
    {},
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\nTWO\n")
})

test("plugin applies insert before, insert after, and append hunks", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const reading = await hooks.tool.read.execute({ path: "a.ts" }, {})
  const header = reading.output.split("\n")[0]

  await hooks.tool.edit.execute(
    {
      patch: [
        header,
        "insert before 1",
        "+zero",
        "insert after 2",
        "+between",
        "append",
        "+three",
      ].join("\n"),
    },
    {},
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "zero\none\ntwo\nbetween\nthree\n")
})

test("plugin exposes an unseen-anchor preview and accepts a complete retry", async () => {
  await writeFile(path.join(root, "a.ts"), Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n") + "\n")
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const reading = await hooks.tool.read.execute({ path: "a.ts", limit: 2 }, {})
  const patch = `${reading.output.split("\n")[0]}\nreplace 9\n+changed`

  await assert.rejects(hooks.tool.edit.execute({ patch }, {}), (error) => {
    assert.deepEqual(error.revealed, [{ line: 9, text: "line-9" }])
    assert.equal(error.truncated, false)
    return true
  })
  await hooks.tool.edit.execute({ patch }, {})
  assert.equal((await readFile(path.join(root, "a.ts"), "utf8")).split("\n")[8], "changed")
})

test("plugin keeps rejecting a retry after a truncated preview", async () => {
  const longLine = "x".repeat(513)
  await writeFile(path.join(root, "a.ts"), `one\n${longLine}\nthree\n`)
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const reading = await hooks.tool.read.execute({ path: "a.ts", limit: 1 }, {})
  const patch = `${reading.output.split("\n")[0]}\nreplace 2\n+changed`

  await assert.rejects(hooks.tool.edit.execute({ patch }, {}), (error) => {
    assert.equal(error.truncated, true)
    assert.equal(error.revealed[0].text.length, 512)
    return true
  })
  await assert.rejects(hooks.tool.edit.execute({ patch }, {}), (error) => error.truncated === true)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), `one\n${longLine}\nthree\n`)
})

test("plugin seam applies the Snapshot Root boundary and rejects foreign rootIds", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  await assert.rejects(
    hooks.tool.read.execute({ path: path.join(outside, "secret.ts") }, {}),
    /Snapshot Root/,
  )

  await symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"))
  await assert.rejects(hooks.tool.read.execute({ path: "link.ts" }, {}), /Snapshot Root/)

  const store = new InMemorySnapshotStore()
  store.record({
    canonicalPath: path.join(root, "a.ts"),
    rootId: "foreign-root",
    text: "one\ntwo\n",
    seenLines: [1, 2],
    lineEnding: "lf",
    bom: false,
  })
  const isolatedHooks = await createHashlineHooks(
    { worktree: root, directory: root },
    { store },
  )
  await assert.rejects(
    isolatedHooks.tool.edit.execute(
      { patch: `[a.ts#${computeTag("one\ntwo\n")}]\nreplace 1\n+NOPE` },
      {},
    ),
    /read first/i,
  )
})
