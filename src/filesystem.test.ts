import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { FileSystemAdapter, PathBoundaryError } from "./filesystem.ts"

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hashline-root-"))
  outside = await mkdtemp(path.join(tmpdir(), "hashline-outside-"))
  await writeFile(path.join(root, "inside.ts"), "one\ntwo\n")
  await writeFile(path.join(outside, "secret.ts"), "secret\n")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("resolves existing files only inside the component boundary", async () => {
  const filesystem = new FileSystemAdapter({ root })
  const resolved = await filesystem.resolve("inside.ts")

  assert.equal(resolved.canonicalPath, path.join(root, "inside.ts"))
  assert.equal(resolved.rootId, path.resolve(root))

  await assert.rejects(filesystem.resolve("../secret.ts"), (error: unknown) => error instanceof PathBoundaryError)
  await assert.rejects(filesystem.resolve(path.join(outside, "secret.ts")), (error: unknown) => error instanceof PathBoundaryError)
})

test("rejects a symlink whose real target is outside the Snapshot Root", async () => {
  await symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"))
  const filesystem = new FileSystemAdapter({ root })

  await assert.rejects(filesystem.resolve("link.ts"), (error: unknown) => error instanceof PathBoundaryError)
})

test("revalidates a symlink before rename", async () => {
  const link = path.join(root, "link.ts")
  const target = path.join(root, "inside.ts")
  await symlink(target, link)
  const filesystem = new FileSystemAdapter({ root })
  const resolved = await filesystem.resolve("link.ts")

  await rm(link)
  await symlink(path.join(outside, "secret.ts"), link)

  await assert.rejects(
    filesystem.writeAtomic({
      inputPath: "link.ts",
      canonicalPath: resolved.canonicalPath,
      rootId: resolved.rootId,
      expectedText: "one\ntwo\n",
      newText: "changed\n",
      lineEnding: "lf",
      bom: false,
    }),
    (error: unknown) => error instanceof PathBoundaryError,
  )
  assert.equal(await readFile(path.join(outside, "secret.ts"), "utf8"), "secret\n")
})

test("writes through a same-directory temporary file and preserves content", async () => {
  const filesystem = new FileSystemAdapter({ root })
  const resolved = await filesystem.resolve("inside.ts")

  await filesystem.writeAtomic({
    inputPath: "inside.ts",
    canonicalPath: resolved.canonicalPath,
    rootId: resolved.rootId,
    expectedText: "one\ntwo\n",
    newText: "changed\n",
    lineEnding: "lf",
    bom: false,
  })

  assert.equal(await readFile(path.join(root, "inside.ts"), "utf8"), "changed\n")
  const entries = await (await import("node:fs/promises")).readdir(root)
  assert.deepEqual(entries.sort(), ["inside.ts"])
})
