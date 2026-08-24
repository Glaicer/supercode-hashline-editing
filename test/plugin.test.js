import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import HashlinePlugin from "../plugin/hashline.js"

let root

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hashline-plugin-"))
  await writeFile(path.join(root, "a.ts"), "one\ntwo\n")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
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
