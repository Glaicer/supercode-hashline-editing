import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { resolveHashlineSettings, setupHashlinePlugin } from "./plugin.ts"
import { computeTag } from "./hash.ts"
import { BoundaryError, MismatchError, SeenLinesError, SnapshotRequiredError } from "./errors.ts"

type AnyRecord = Record<string, any>

type ToolContextLike = AnyRecord

const CONTEXT: ToolContextLike = {
  sessionID: "ses_hashline_probe",
  agent: "agent_hashline_probe",
  messageID: "msg_hashline_probe",
  id: "call_hashline_probe",
  signal: new AbortController().signal,
  progress: async () => {},
}

function createFakeEditor() {
  const tools = new Map<string, AnyRecord>()
  return {
    tools,
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: (_namespace: unknown) => {},
    add: (tool: AnyRecord) => {
      tools.set(tool.name, { id: tool.name, ...tool })
    },
    update: (id: string, update: (tool: AnyRecord) => void) => {
      const current = tools.get(id)
      if (!current) return
      const draft = { ...current }
      update(draft)
      draft.name = current.name
      draft.id = id
      tools.set(id, draft)
    },
    remove: (id: string) => {
      tools.delete(id)
    },
  }
}

interface NativeReadBehavior {
  execute: (input: AnyRecord, context: ToolContextLike) => Promise<AnyRecord>
  input?: unknown
  output?: unknown
}

function nativeTextResult(relPath: string, text: string, extra: AnyRecord = {}): AnyRecord {
  const lines = text === "" ? [] : text.split("\n").slice(0, -1)
  const numbered = lines.map((line: string, index: number) => `${index + 1}: ${line}`).join("\n")
  return {
    output: {
      type: "file",
      encoding: "utf8",
      content: text,
      mime: "text/plain",
      uri: `file:///tmp/hashline-probe/${relPath}`,
      name: path.basename(relPath),
    },
    content:
      lines.length === 0
        ? `Read file ${relPath}, 0 lines`
        : `Read file ${relPath}, lines 1-${lines.length}\n${numbered}`,
    metadata: { truncated: false, ...extra },
  }
}

function nativeListResult(relPath: string): AnyRecord {
  return {
    output: { type: "list-page", entries: [{ path: "a.ts", type: "file" }], truncated: false },
    content: `Read directory ${relPath}, entries 1-1\na.ts`,
    metadata: { truncated: false },
  }
}

function nativeMediaResult(relPath: string): AnyRecord {
  return {
    output: {
      type: "file",
      encoding: "base64",
      content: "cHJvYmU=",
      mime: "image/png",
      uri: `file:///tmp/hashline-probe/${relPath}`,
      name: path.basename(relPath),
    },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: "data:image/png;base64,cHJvYmU=", mime: "image/png", name: relPath },
    ],
    metadata: { truncated: false },
  }
}

interface HarnessInput {
  directory: string
  options?: unknown
  nativeRead?: NativeReadBehavior
}

interface Harness {
  tools: Map<string, AnyRecord>
  nativeCalls: Array<{ input: AnyRecord; context: ToolContextLike }>
  cleanup: () => Promise<void>
  disposed: () => boolean
  replay: (withNative?: boolean) => Map<string, AnyRecord>
}

async function createHarness({ directory, options, nativeRead }: HarnessInput): Promise<Harness> {
  const editor = createFakeEditor()
  const nativeCalls: Array<{ input: AnyRecord; context: ToolContextLike }> = []
  const addNativeRead = (target: ReturnType<typeof createFakeEditor>) => {
    if (!nativeRead) return
    target.add({
      name: "read",
      description: "native read",
      input: nativeRead.input ?? { type: "object", properties: { path: { type: "string" } } },
      output: nativeRead.output,
      execute: async (input: AnyRecord, context: ToolContextLike) => {
        nativeCalls.push({ input, context })
        return nativeRead.execute(input, context)
      },
    })
  }
  addNativeRead(editor)

  const transforms: Array<(target: ReturnType<typeof createFakeEditor>) => void> = []
  let disposeCount = 0
  const ctx = {
    location: { directory },
    options: options ?? {},
    tool: {
      transform: async (callback: (target: ReturnType<typeof createFakeEditor>) => void) => {
        transforms.push(callback)
        callback(editor)
        return { dispose: async () => void (disposeCount += 1) }
      },
    },
  } as unknown as Parameters<typeof setupHashlinePlugin>[0]

  const cleanup = await setupHashlinePlugin(ctx)
  return {
    tools: editor.tools,
    nativeCalls,
    cleanup,
    disposed: () => disposeCount > 0,
    replay: (withNative = true) => {
      const fresh = createFakeEditor()
      if (withNative) addNativeRead(fresh)
      for (const callback of transforms) callback(fresh)
      return fresh.tools
    },
  }
}

function readTool(tools: Map<string, AnyRecord>): AnyRecord {
  const tool = tools.get("read")
  assert.ok(tool, "read tool must be registered")
  return tool
}

function editTool(tools: Map<string, AnyRecord>): AnyRecord {
  const tool = tools.get("edit")
  assert.ok(tool, "edit tool must be registered")
  return tool
}

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hashline-v2-"))
  outside = await mkdtemp(path.join(tmpdir(), "hashline-v2-outside-"))
  await writeFile(path.join(root, "a.ts"), "one\ntwo\n")
  await writeFile(path.join(outside, "secret.ts"), "secret\n")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("setup overrides read/edit by name with native registration options", async () => {
  const nativeInput = { type: "object", properties: { path: { type: "string" } } }
  const nativeOutput = { type: "object", properties: { type: { type: "string" } } }
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      input: nativeInput,
      output: nativeOutput,
      execute: async () => nativeTextResult("a.ts", "one\ntwo\n"),
    },
  })

  assert.ok(harness.tools.has("read"))
  assert.ok(harness.tools.has("edit"))
  assert.deepEqual(readTool(harness.tools).options, { codemode: false })
  assert.deepEqual(editTool(harness.tools).options, { codemode: false, permission: "edit" })
  assert.equal(readTool(harness.tools).input, nativeInput)
  assert.equal(readTool(harness.tools).output, nativeOutput)
  assert.notEqual(readTool(harness.tools).execute, undefined)
  assert.notEqual(editTool(harness.tools).input, undefined)
})

test("native read missing: read refuses loudly instead of degrading silently", async () => {
  const harness = await createHarness({ directory: root })
  const read = readTool(harness.tools)
  await assert.rejects(
    read.execute({ path: "a.ts" }, CONTEXT),
    /refuses to read without its native executor/,
  )
  await assert.rejects(
    editTool(harness.tools).execute(
      { patch: `[a.ts#${computeTag("one\ntwo\n")}]\nreplace 1\n+ONE` },
      CONTEXT,
    ),
    (error: unknown) => error instanceof SnapshotRequiredError,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("text read returns [PATH#TAG] plus absolute numbered lines and mints a Snapshot", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })

  const result = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  assert.match(result.content, /^\[a\.ts#[0-9A-F]{4}\]\n1:one\n2:two$/)
  assert.equal(harness.nativeCalls.length, 1)
  assert.deepEqual(harness.nativeCalls[0].input, { path: "a.ts" })
  assert.equal(harness.nativeCalls[0].context, CONTEXT)
  const header = result.content.split("\n")[0]
  assert.equal(result.metadata.tag, header.slice(1, -1).split("#")[1])
  assert.deepEqual(result.metadata.seenLines, [1, 2])
  assert.equal(result.metadata.path, "a.ts")

  await editTool(harness.tools).execute(
    { patch: `${header}\nreplace 2\n+TWO` },
    CONTEXT,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\nTWO\n")
})

test("a single blank line is numbered and can be edited", async () => {
  await writeFile(path.join(root, "blank.txt"), "\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async () => nativeTextResult("blank.txt", "\n") },
  })
  const result = await readTool(harness.tools).execute({ path: "blank.txt" }, CONTEXT)
  assert.match(result.content, /^\[blank\.txt#[0-9A-F]{4}\]\n1:$/)
  assert.deepEqual(result.metadata.seenLines, [1])
  await editTool(harness.tools).execute({ patch: `${result.metadata.header}\nreplace 1\n+filled` }, CONTEXT)
  assert.equal(await readFile(path.join(root, "blank.txt"), "utf8"), "filled\n")
})

test("a paged single blank line remains visible despite native empty page content", async () => {
  await writeFile(path.join(root, "blank.txt"), "\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async () => ({
      output: { type: "text-page", content: "", offset: 1, truncated: false },
      content: "Read file blank.txt, 0 lines",
      metadata: { truncated: false },
    }) },
  })
  const result = await readTool(harness.tools).execute({ path: "blank.txt", limit: 1 }, CONTEXT)
  assert.match(result.content, /^\[blank\.txt#[0-9A-F]{4}\]\n1:$/)
  assert.deepEqual(result.metadata.seenLines, [1])
})

test("directory and media reads pass the native result through without a tag", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => {
        if (String(input.path).endsWith(".png")) return nativeMediaResult(String(input.path))
        return nativeListResult(".")
      },
    },
  })

  const directoryRead = await readTool(harness.tools).execute({ path: "." }, CONTEXT)
  assert.equal(directoryRead.content, "Read directory ., entries 1-1\na.ts")
  assert.deepEqual(directoryRead.metadata, { truncated: false })
  assert.doesNotMatch(String(directoryRead.content), /#/)
  assert.equal(directoryRead.output.type, "list-page")

  const mediaRead = await readTool(harness.tools).execute({ path: "img.png" }, CONTEXT)
  assert.equal((mediaRead.content as AnyRecord[])[1].uri, "data:image/png;base64,cHJvYmU=")
  assert.equal(mediaRead.metadata.truncated, false)
  assert.equal(mediaRead.output.type, "file")
  assert.equal(harness.nativeCalls.length, 2)
})

test("outside-root directories and symlinks are refused before native read", async () => {
  await symlink(outside, path.join(root, "escape"))
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async () => nativeListResult("outside") },
  })
  for (const target of [outside, path.join(root, "escape")]) {
    await assert.rejects(
      readTool(harness.tools).execute({ path: target }, CONTEXT),
      (error: unknown) => error instanceof BoundaryError,
    )
  }
  assert.equal(harness.nativeCalls.length, 0)
})

test("native read failures propagate unchanged", async () => {
  const nativeError = new Error("File not found: a.tss\n\nDid you mean one of these?\na.ts")
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async () => {
        throw nativeError
      },
    },
  })

  await assert.rejects(
    readTool(harness.tools).execute({ path: "a.tss" }, CONTEXT),
    (error: unknown) => error === nativeError,
  )
})

test("read to edit replace chain updates the file and reports header plus firstChangedLine", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })

  const reading = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  const header = reading.content.split("\n")[0]
  const editing = await editTool(harness.tools).execute(
    { patch: `${header}\nreplace 1-2\n+ONE\n+TWO` },
    CONTEXT,
  )
  assert.match(editing.content, /\[a\.ts#[0-9A-F]{4}\]/)
  assert.match(editing.content, /firstChangedLine: 1/)
  assert.equal(editing.metadata.sections[0].firstChangedLine, 1)
  assert.deepEqual(editing.metadata.written, editing.metadata.sections.map((section: AnyRecord) => section.canonicalPath))
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\nTWO\n")
})

test("stale Tag rejects with MismatchError before any write", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })

  const reading = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  const tag = reading.metadata.tag
  const staleTag = tag === "FFFF" ? "0000" : "FFFF"
  await assert.rejects(
    editTool(harness.tools).execute(
      { patch: `[a.ts#${staleTag}]\nreplace 1\n+X` },
      CONTEXT,
    ),
    (error: unknown) => {
      assert.ok(error instanceof MismatchError)
      assert.equal((error as MismatchError).expectedTag, staleTag)
      assert.equal((error as MismatchError).actualTag, tag)
      return true
    },
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("text outside the Snapshot Root refuses instead of returning an untagged read", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => nativeTextResult(String(input.path), "secret\n"),
    },
  })

  await assert.rejects(
    readTool(harness.tools).execute({ path: path.join(outside, "secret.ts") }, CONTEXT),
    (error: unknown) => error instanceof BoundaryError,
  )
})

test("window reads keep absolute line numbers and union SeenLines across reads", async () => {
  await writeFile(path.join(root, "a.ts"), "one\ntwo\nthree\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => {
        const start = input.offset ?? 1
        const lines = ["one", "two", "three"]
        const visible = lines.slice(start - 1, start - 1 + (input.limit ?? 2000))
        const next = start - 1 + visible.length < lines.length ? start + visible.length : undefined
        return {
          ...nativeTextResult(String(input.path), "one\ntwo\nthree\n"),
          output: { type: "text-page", content: visible.join("\n"), offset: start, truncated: next !== undefined, next },
          metadata: { truncated: next !== undefined },
        }
      },
    },
  })

  const first = await readTool(harness.tools).execute({ path: "a.ts", limit: 1 }, CONTEXT)
  assert.match(first.content, /^\[a\.ts#[0-9A-F]{4}\]\n1:one\n\[Output truncated\. Continue reading with offset: 2\]$/)
  const tag = first.metadata.tag

  const second = await readTool(harness.tools).execute(
    { path: "a.ts", offset: 2, limit: 2 },
    CONTEXT,
  )
  assert.match(second.content, /^\[a\.ts#[0-9A-F]{4}\]\n2:two\n3:three$/)
  assert.equal(second.metadata.tag, tag)
  assert.deepEqual(second.metadata.seenLines, [1, 2, 3])

  const header = second.content.split("\n")[0]
  await editTool(harness.tools).execute(
    { patch: `${header}\nreplace 2\n+TWO` },
    CONTEXT,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\nTWO\nthree\n")
})

test("long lines are clamped and their hidden tails do not authorize edits", async () => {
  const long = "x".repeat(3000)
  await writeFile(path.join(root, "long.txt"), `${long}\nend\n`)
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => nativeTextResult(String(input.path), `${long}\nend\n`),
    },
  })

  const result = await readTool(harness.tools).execute({ path: "long.txt" }, CONTEXT)
  const lines = String(result.content).split("\n")
  const suffix = "... (line truncated to 2000 chars)"
  assert.equal(lines.length, 3)
  assert.equal(lines[1].length, "1:".length + 2000 + suffix.length)
  assert.match(lines[1], /\.\.\. \(line truncated to 2000 chars\)$/)

  const header = lines[0]
  assert.deepEqual(result.metadata.seenLines, [2])
  await assert.rejects(
    editTool(harness.tools).execute({ patch: `${header}\nreplace 1\n+X` }, CONTEXT),
    (error: unknown) => error instanceof SeenLinesError,
  )
  await editTool(harness.tools).execute(
    { patch: `${header}\nreplace 2\n+END` },
    CONTEXT,
  )
  assert.equal(await readFile(path.join(root, "long.txt"), "utf8"), `${long}\nEND\n`)
})

test("native byte-limited page bounds the tagged window and SeenLines", async () => {
  await writeFile(path.join(root, "a.ts"), "one\ntwo\nthree\nfour\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async () => ({
        output: { type: "text-page", content: "one\ntwo", offset: 1, truncated: true, next: 3 },
        content: "Read file a.ts, lines 1-2\n1: one\n2: two\n[Output truncated. Continue reading with offset: 3]",
        metadata: { truncated: true },
      }),
    },
  })
  const result = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  assert.match(result.content, /^\[a\.ts#[0-9A-F]{4}\]\n1:one\n2:two\n\[Output truncated\. Continue reading with offset: 3\]$/)
  assert.deepEqual(result.metadata.seenLines, [1, 2])
  await assert.rejects(
    editTool(harness.tools).execute({ patch: `${result.metadata.header}\nreplace 3\n+THREE` }, CONTEXT),
    (error: unknown) => error instanceof SeenLinesError,
  )
})

test("native NFC alternate path becomes the tagged editable path", async () => {
  const actual = path.join(root, "é.ts")
  const requested = path.join(root, "e\u0301.ts")
  await writeFile(actual, "actual\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async () => ({
        ...nativeTextResult(actual, "actual\n"),
        output: {
          type: "text-page",
          content: "actual",
          offset: 1,
          truncated: false,
        },
      }),
    },
  })
  const result = await readTool(harness.tools).execute({ path: requested }, CONTEXT)
  assert.match(result.content, /é\.ts#[0-9A-F]{4}\]\n1:actual$/)
  await editTool(harness.tools).execute({ patch: `${result.metadata.header}\nreplace 1\n+ACTUAL` }, CONTEXT)
  assert.equal(await readFile(actual, "utf8"), "ACTUAL\n")
})

test("reads are capped at 2000 lines with the native continuation footer", async () => {
  const text = `${Array.from({ length: 2500 }, (_, index) => `line-${index + 1}`).join("\n")}\n`
  await writeFile(path.join(root, "big.txt"), text)
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => {
        const native = nativeTextResult(String(input.path), text)
        return {
          ...native,
          output: {
            type: "text-page",
            content: Array.from({ length: 2000 }, (_, index) => `line-${index + 1}`).join("\n"),
            mime: "text/plain",
            offset: 1,
            truncated: true,
            next: 2001,
          },
          metadata: { truncated: true },
        }
      },
    },
  })

  const result = await readTool(harness.tools).execute({ path: "big.txt" }, CONTEXT)
  const lines = String(result.content).split("\n")
  assert.equal(lines.length, 2002)
  assert.match(lines[1], /^1:line-1$/)
  assert.match(lines[2000], /^2000:line-2000$/)
  assert.equal(lines[2001], "[Output truncated. Continue reading with offset: 2001]")
})

test("plugin options apply: roots extend the Snapshot Root and the guard can be disabled", async () => {
  const rooted = await createHarness({
    directory: root,
    options: { roots: [outside] },
    nativeRead: {
      execute: async (input) => nativeTextResult(String(input.path), "secret\n"),
    },
  })
  const outsideRead = await readTool(rooted.tools).execute(
    { path: path.join(outside, "secret.ts") },
    CONTEXT,
  )
  assert.match(String(outsideRead.content), /^\[.*secret\.ts#[0-9A-F]{4}\]\n1:secret$/)
  const outsideHeader = String(outsideRead.content).split("\n")[0]
  await editTool(rooted.tools).execute(
    { patch: `${outsideHeader}\nreplace 1\n+SECRET` },
    CONTEXT,
  )
  assert.equal(await readFile(path.join(outside, "secret.ts"), "utf8"), "SECRET\n")

  const guarded = await createHarness({
    directory: root,
    options: { enforceSeenLines: false },
    nativeRead: {
      execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n"),
    },
  })
  const partial = await readTool(guarded.tools).execute({ path: "a.ts", limit: 1 }, CONTEXT)
  await editTool(guarded.tools).execute(
    { patch: `${String(partial.content).split("\n")[0]}\nreplace 2\n+TWO` },
    CONTEXT,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\nTWO\n")

  const defaultGuard = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n"),
    },
  })
  await writeFile(path.join(root, "a.ts"), "one\ntwo\n")
  const limited = await readTool(defaultGuard.tools).execute({ path: "a.ts", limit: 1 }, CONTEXT)
  await assert.rejects(
    editTool(defaultGuard.tools).execute(
      { patch: `${String(limited.content).split("\n")[0]}\nreplace 2\n+TWO` },
      CONTEXT,
    ),
    /re-read the missing lines and retry/,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("two Locations get isolated snapshot stores", async () => {
  const harnessA = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const directoryB = await mkdtemp(path.join(tmpdir(), "hashline-v2-b-"))
  try {
    await writeFile(path.join(directoryB, "a.ts"), "one\ntwo\n")
    const harnessB = await createHarness({
      directory: directoryB,
      nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
    })

    const readA = await readTool(harnessA.tools).execute({ path: "a.ts" }, CONTEXT)
    const headerA = String(readA.content).split("\n")[0]
    await assert.rejects(
      editTool(harnessB.tools).execute(
        { patch: `${headerA}\nreplace 1\n+X` },
        CONTEXT,
      ),
      (error: unknown) => error instanceof SnapshotRequiredError,
    )
    assert.equal(await readFile(path.join(directoryB, "a.ts"), "utf8"), "one\ntwo\n")

    await editTool(harnessA.tools).execute(
      { patch: `${headerA}\nreplace 1\n+ONE` },
      CONTEXT,
    )
    assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\n")
  } finally {
    await rm(directoryB, { recursive: true, force: true })
  }
})

test("transform replay re-captures the native executor per run", async () => {
  let calls = 0
  const harness = await createHarness({
    directory: root,
    nativeRead: {
      execute: async (input) => {
        calls += 1
        return nativeTextResult(String(input.path), "one\ntwo\n")
      },
    },
  })

  const first = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  assert.match(String(first.content), /2:two$/)
  assert.equal(calls, 1)

  const replayed = harness.replay()
  const second = await readTool(replayed).execute({ path: "a.ts" }, CONTEXT)
  assert.match(String(second.content), /2:two$/)
  assert.equal(calls, 2)

  const orphan = harness.replay(false)
  await assert.rejects(
    readTool(orphan).execute({ path: "a.ts" }, CONTEXT),
    /refuses to read without its native executor/,
  )
})

test("cleanup disposes the tool registration", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  assert.equal(harness.disposed(), false)
  await harness.cleanup()
  assert.equal(harness.disposed(), true)
})

test("resolveHashlineSettings validates roots and defaults the rest", () => {
  const defaults = resolveHashlineSettings(undefined, root)
  assert.deepEqual(defaults, {
    enforceSeenLines: true,
    roots: [],
    maxPaths: 256,
    maxVersionsPerPath: 4,
    maxTotalBytes: 64 * 1024 * 1024,
  })

  assert.throws(() => resolveHashlineSettings({ roots: "nope" }, root), /roots must be an array/)
  assert.throws(
    () => resolveHashlineSettings({ roots: [""] }, root),
    /roots must contain non-empty paths/,
  )

  const configured = resolveHashlineSettings(
    { enforceSeenLines: false, roots: ["extra"], maxPaths: 10 },
    root,
  )
  assert.equal(configured.enforceSeenLines, false)
  assert.deepEqual(configured.roots, [path.resolve(root, "extra")])
  assert.equal(configured.maxPaths, 10)
  assert.equal(configured.maxVersionsPerPath, 4)

  const ignored = resolveHashlineSettings("not-a-record", root)
  assert.equal(ignored.enforceSeenLines, true)

  const absolute = resolveHashlineSettings({ roots: [outside] }, root)
  assert.deepEqual(absolute.roots, [outside])
})

test("domain errors keep their class across the wrapper", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => ({
      ...nativeTextResult(String(input.path), "one\ntwo\n"),
      output: { type: "text-page", content: "one\ntwo", offset: 1, truncated: false },
    }) },
  })
  await assert.rejects(
    readTool(harness.tools).execute({ path: "missing.ts" }, CONTEXT),
    (error: unknown) => error instanceof Error && error.name === "FileNotFoundError",
  )
})
