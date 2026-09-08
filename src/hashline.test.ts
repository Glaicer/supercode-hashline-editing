import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rename as renameFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import HashlinePlugin, { createHashlineHooks } from "./hashline.ts"
import { FileSystemAdapter } from "./filesystem.ts"
import { DuplicatePathError } from "./service.ts"
import { computeTag } from "./hash.ts"
import { InMemorySnapshotStore } from "./snapshots.ts"

/** Commit-report fields are attached dynamically; narrow `unknown` rejections to read them. */
interface RejectedEdit extends Error {
  path?: string
  canonicalPath?: string
  written?: string[]
  rolledBack?: string[]
  partiallyWritten?: string[]
  unwritten?: string[]
  revealed?: Array<{ line: number; text: string }>
  truncated?: boolean
}

function asRejected(error: unknown): RejectedEdit {
  return error as RejectedEdit
}

let root: string
let outside: string

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

test("config disables hashline tools while the default keeps them enabled", async () => {
  const disabled = await HashlinePlugin(
    { worktree: root, directory: root },
    { config: { hashline: { enabled: false } } },
  )

  assert.deepEqual(Object.keys(disabled.tool), [])
  assert.equal(disabled.tool.read, undefined)
  assert.equal(disabled.tool.edit, undefined)

  const configuredAfterStartup = await HashlinePlugin({ worktree: root, directory: root })
  await configuredAfterStartup.config({ hashline: { enabled: false } })
  assert.deepEqual(Object.keys(configuredAfterStartup.tool), [])

  const defaults = await HashlinePlugin({ worktree: root, directory: root })
  assert.deepEqual(Object.keys(defaults.tool).sort(), ["edit", "read"])
})

test("config forwards guard, Snapshot Store limits, and extra Snapshot Roots", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  await hooks.config({
    hashline: {
      enforceSeenLines: false,
      maxPaths: 1,
      maxVersionsPerPath: 1,
      maxTotalBytes: 8,
      roots: [outside],
    },
  })

  const reading = await hooks.tool.read.execute({ path: "a.ts", limit: 1 }, {})
  await hooks.tool.edit.execute(
    { patch: `${reading.output.split("\n")[0]}\nreplace 2\n+TWO` },
    {},
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\nTWO\n")

  const extraRootReading = await hooks.tool.read.execute(
    { path: path.join(outside, "secret.ts") },
    {},
  )
  assert.match(extraRootReading.output, /secret/)

  const current = await hooks.tool.read.execute({ path: "a.ts" }, {})
  await assert.rejects(
    hooks.tool.edit.execute(
      { patch: `${current.output.split("\n")[0]}\nreplace 1\n+too-long` },
      {},
    ),
    /Snapshot.*limit/,
  )
})

test("config refresh keeps the process Snapshot store and its Tags", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const reading = await hooks.tool.read.execute({ path: "a.ts" }, {})

  await hooks.config({ hashline: { enforceSeenLines: false } })
  await hooks.tool.edit.execute(
    { patch: `${reading.output.split("\n")[0]}\nreplace 1\n+ONE` },
    {},
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\n")
})

test("edit description documents the complete hashline patch format", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const description = hooks.tool.edit.description

  for (const fragment of [
    "[PATH#TAG]",
    "multiple sections",
    "one section per file",
    "replace N-M",
    "replace N",
    "insert before N",
    "insert after N",
    "append",
    "+TEXT",
    "single `+`",
    "+- item",
    "++ item",
    "original Snapshot",
    "do not shift",
    "-old",
    "context lines",
    "NEVER format/restyle",
  ]) {
    assert.match(description, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), fragment)
  }
})

test("plugin reports targeted messages for unsupported patch operations", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const header = (await hooks.tool.read.execute({ path: "a.ts" }, {})).output.split("\n")[0]
  const cases: Array<[string, RegExp]> = [
    ["replace 5*", /block ops not supported.*replace N-M/],
    ["CUT", /clipboard not supported/],
    ["@name", /clipboard not supported/],
    ["REM", /deletion and movement.*guarded_bash/],
    ["MV", /deletion and movement.*guarded_bash/],
    ["PUT", /Oh My Pi syntax not supported.*edit tool/],
    [".=", /Oh My Pi syntax not supported.*edit tool/],
  ]

  for (const [operation, message] of cases) {
    await assert.rejects(
      hooks.tool.edit.execute({ patch: `${header}\n${operation}\n+body` }, {}),
      message,
    )
  }
})

test("plugin preserves a read-edit-read-insert chain and rejects the stale tag", async () => {
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const first = await hooks.tool.read.execute({ path: "a.ts" }, {})
  const firstHeader = first.output.split("\n")[0]

  const replaced = await hooks.tool.edit.execute(
    { patch: `${firstHeader}\nreplace 1\n+ONE` },
    {},
  )
  const second = await hooks.tool.read.execute({ path: "a.ts" }, {})
  assert.equal(second.output.split("\n")[0], replaced.metadata.sections[0].header)

  await hooks.tool.edit.execute(
    { patch: `${second.output.split("\n")[0]}\ninsert after 2\n+three` },
    {},
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\nthree\n")

  await assert.rejects(
    hooks.tool.edit.execute({ patch: `${firstHeader}\nreplace 1\n+stale` }, {}),
    /MismatchError|re-read/i,
  )
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

test("plugin applies a multi-section patch to two files", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\nbeta\n")
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const aReading = await hooks.tool.read.execute({ path: "a.ts" }, {})
  const bReading = await hooks.tool.read.execute({ path: "b.ts" }, {})
  const aHeader = aReading.output.split("\n")[0]
  const bHeader = bReading.output.split("\n")[0]

  const result = await hooks.tool.edit.execute(
    {
      patch: [
        aHeader,
        "replace 1",
        "+ONE",
        bHeader,
        "replace 2",
        "+BETA",
      ].join("\n"),
    },
    {},
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "alpha\nBETA\n")
  assert.equal(result.metadata.sections.length, 2)
  assert.deepEqual(result.metadata.written, [path.join(root, "a.ts"), path.join(root, "b.ts")])
  assert.deepEqual(result.metadata.rolledBack, [])
  assert.deepEqual(result.metadata.partiallyWritten, [])
})

test("plugin preflights every section before writing any file", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\nbeta\n")
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const aReading = await hooks.tool.read.execute({ path: "a.ts" }, {})
  const bReading = await hooks.tool.read.execute({ path: "b.ts" }, {})
  const aHeader = aReading.output.split("\n")[0]
  const bHeader = bReading.output.split("\n")[0]
  await writeFile(path.join(root, "b.ts"), "changed\nbeta\n")

  await assert.rejects(
    hooks.tool.edit.execute(
      {
        patch: [aHeader, "replace 1", "+ONE", bHeader, "replace 1", "+ALPHA"].join("\n"),
      },
      {},
    ),
    (error: unknown) => {
      const failure = asRejected(error)
      assert.equal(failure.path, "b.ts")
      assert.deepEqual(failure.written, [])
      assert.deepEqual(failure.rolledBack, [])
      assert.deepEqual(failure.partiallyWritten, [])
      assert.match(failure.message, /b\.ts/)
      return /re-read/i.test(failure.message)
    },
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "changed\nbeta\n")
})

test("plugin rolls back earlier sections when a later rename fails", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\nbeta\n")
  let renameCount = 0
  const filesystem = new FileSystemAdapter({
    root,
    rename: async (...args) => {
      renameCount += 1
      if (renameCount === 2) throw new Error("injected rename 2 failure")
      return renameFile(...args)
    },
  })
  const hooks = await HashlinePlugin({ worktree: root, directory: root }, { filesystem })
  const aHeader = (await hooks.tool.read.execute({ path: "a.ts" }, {})).output.split("\n")[0]
  const bHeader = (await hooks.tool.read.execute({ path: "b.ts" }, {})).output.split("\n")[0]

  await assert.rejects(
    hooks.tool.edit.execute(
      {
        patch: [aHeader, "replace 1", "+ONE", bHeader, "replace 1", "+ALPHA"].join("\n"),
      },
      {},
    ),
    (error: unknown) => {
      const failure = asRejected(error)
      assert.deepEqual(failure.written, [path.join(root, "a.ts")])
      assert.deepEqual(failure.rolledBack, [path.join(root, "a.ts")])
      assert.deepEqual(failure.partiallyWritten, [])
      assert.match(failure.message, /a\.ts|b\.ts/)
      return /injected rename 2 failure/.test(failure.message)
    },
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "alpha\nbeta\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "b.ts"])
})

test("plugin reports a partial write when rollback fails", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\nbeta\n")
  let renameCount = 0
  const filesystem = new FileSystemAdapter({
    root,
    rename: async (...args) => {
      renameCount += 1
      if (renameCount === 2 || renameCount === 3) throw new Error(`injected rename ${renameCount} failure`)
      return renameFile(...args)
    },
  })
  const hooks = await HashlinePlugin({ worktree: root, directory: root }, { filesystem })
  const aHeader = (await hooks.tool.read.execute({ path: "a.ts" }, {})).output.split("\n")[0]
  const bHeader = (await hooks.tool.read.execute({ path: "b.ts" }, {})).output.split("\n")[0]

  await assert.rejects(
    hooks.tool.edit.execute(
      {
        patch: [aHeader, "replace 1", "+ONE", bHeader, "replace 1", "+ALPHA"].join("\n"),
      },
      {},
    ),
    (error: unknown) => {
      const failure = asRejected(error)
      assert.deepEqual(failure.written, [path.join(root, "a.ts")])
      assert.deepEqual(failure.rolledBack, [])
      assert.deepEqual(failure.partiallyWritten, [path.join(root, "a.ts")])
      assert.deepEqual(failure.unwritten, [path.join(root, "b.ts")])
      assert.match(failure.message, /a\.ts/)
      assert.match(failure.message, /b\.ts/)
      return /injected rename 2 failure/.test(failure.message)
    },
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "alpha\nbeta\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "b.ts"])
})

test("plugin rejects sections that resolve to one canonical path", async () => {
  await symlink(path.join(root, "a.ts"), path.join(root, "alias.ts"))
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const aHeader = (await hooks.tool.read.execute({ path: "a.ts" }, {})).output.split("\n")[0]
  const aliasHeader = (await hooks.tool.read.execute({ path: "alias.ts" }, {})).output.split("\n")[0]

  await assert.rejects(
    hooks.tool.edit.execute(
      {
        patch: [aHeader, "replace 1", "+ONE", aliasHeader, "replace 2", "+TWO"].join("\n"),
      },
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof DuplicatePathError)
      const failure = asRejected(error)
      assert.equal(failure.canonicalPath, path.join(root, "a.ts"))
      assert.deepEqual(failure.written, [])
      return /a\.ts|alias\.ts/.test(failure.message)
    },
  )

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "alias.ts"])
})

test("plugin exposes an unseen-anchor preview and accepts a complete retry", async () => {
  await writeFile(path.join(root, "a.ts"), Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n") + "\n")
  const hooks = await HashlinePlugin({ worktree: root, directory: root })
  const reading = await hooks.tool.read.execute({ path: "a.ts", limit: 2 }, {})
  const patch = `${reading.output.split("\n")[0]}\nreplace 9\n+changed`

  await assert.rejects(hooks.tool.edit.execute({ patch }, {}), (error: unknown) => {
    assert.ok(error instanceof Error)
    const failure = asRejected(error)
    assert.deepEqual(failure.revealed, [{ line: 9, text: "line-9" }])
    assert.equal(failure.truncated, false)
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

  await assert.rejects(hooks.tool.edit.execute({ patch }, {}), (error: unknown) => {
    assert.ok(error instanceof Error)
    const failure = asRejected(error)
    assert.equal(failure.truncated, true)
    assert.equal(failure.revealed?.[0]?.text.length, 512)
    return true
  })
  await assert.rejects(hooks.tool.edit.execute({ patch }, {}), (error: unknown) => (error as RejectedEdit).truncated === true)
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
