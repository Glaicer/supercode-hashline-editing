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
