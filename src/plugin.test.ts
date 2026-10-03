import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Schema } from "effect"
import { resolveHashlineSettings, setupHashlinePlugin } from "./plugin.ts"
import { computeTag } from "./hash.ts"
import { BoundaryError, DuplicatePathError, MismatchError, NoChangesError, SeenLinesError, SnapshotRequiredError } from "./errors.ts"
import { FileSystemAdapter } from "./filesystem.ts"
import { PatchSyntaxError } from "./parser.ts"

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

const NATIVE_WRITE_DESCRIPTION = "Create or overwrite a file with the given content."

// Mirrors the native write tool's Effect Schema input (packages/core/src/tool/plugin/write.ts).
const NATIVE_WRITE_INPUT = Schema.Struct({
  path: Schema.String.annotate({ description: "Path to the file to create or overwrite" }),
  content: Schema.String.annotate({ description: "Full file content to write" }),
})

const NATIVE_WRITE_JSON = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to create or overwrite" },
    content: { type: "string", description: "Full file content to write" },
  },
  required: ["path", "content"],
  additionalProperties: false,
}

const DEFINED_INNER = Schema.Struct({ x: Schema.String }).annotate({ identifier: "Inner" })

const DEFINED_INPUT = Schema.Struct({ inner: DEFINED_INNER, more: Schema.String })

const DEFINED_INPUT_JSON = {
  type: "object",
  properties: {
    inner: { $ref: "#/$defs/Inner" },
    more: { type: "string" },
  },
  required: ["inner", "more"],
  additionalProperties: false,
  $defs: {
    Inner: {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false,
    },
  },
}

function addFakeBuiltins(target: ReturnType<typeof createFakeEditor>) {
  target.add({
    name: "write",
    description: NATIVE_WRITE_DESCRIPTION,
    input: NATIVE_WRITE_INPUT,
    execute: async () => ({ content: "written" }),
  })
  target.add({
    name: "patch",
    description: "Apply a patch to files",
    input: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false },
    execute: async () => ({ content: "patched" }),
  })
}

type SurfaceCallback = (event: AnyRecord) => Promise<void> | void

function createFakeSession() {
  const hooks = new Map<string, Set<SurfaceCallback>>()
  let activeCount = 0
  return {
    hook: async (name: string, callback: SurfaceCallback) => {
      const bucket = hooks.get(name) ?? new Set<SurfaceCallback>()
      hooks.set(name, bucket)
      bucket.add(callback)
      activeCount += 1
      return {
        dispose: async () => {
          if (bucket.delete(callback)) activeCount -= 1
        },
      }
    },
    activeCount: () => activeCount,
    deliver: async (name: string, event: AnyRecord) => {
      for (const callback of hooks.get(name) ?? []) await callback(event)
    },
  }
}

// Mirrors how the host builds the hook record from tool definitions
// (packages/core/src/session/model-request.ts:219 with tool/runtime.ts inputJsonSchema).
function hostInputJson(input: unknown): unknown {
  if (input === undefined || input === null) return {}
  if (!Schema.isSchema(input)) return input
  return Schema.toJsonSchemaDocument(input).schema
}

function surfaceRecord(tools: Map<string, AnyRecord>): Record<string, AnyRecord> {
  return Object.fromEntries(
    [...tools.values()].map((tool) => [tool.name, { description: tool.description, input: hostInputJson(tool.input) }]),
  )
}

// Mirrors the built-in PatchTool context hook in packages/core/src/tool/plugin/patch.ts:296-309.
function builtinPatchGating(modelID: string, tools: Record<string, AnyRecord>) {
  const usePatch = modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
  if (usePatch) {
    delete tools.edit
    delete tools.write
    return
  }
  delete tools.patch
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
  filesystem?: FileSystemAdapter
}

interface Harness {
  tools: Map<string, AnyRecord>
  nativeCalls: Array<{ input: AnyRecord; context: ToolContextLike }>
  cleanup: () => Promise<void>
  disposed: () => boolean
  hooksActive: () => number
  dispatchSurface: (modelID: string, hookName?: string) => Promise<Record<string, AnyRecord>>
  replay: (withNative?: boolean) => Map<string, AnyRecord>
}

async function createHarness({ directory, options, nativeRead, filesystem }: HarnessInput): Promise<Harness> {
  const editor = createFakeEditor()
  const nativeCalls: Array<{ input: AnyRecord; context: ToolContextLike }> = []
  addFakeBuiltins(editor)
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

  const session = createFakeSession()
  const transforms: Array<(target: ReturnType<typeof createFakeEditor>) => void> = []
  let disposeCount = 0
  const ctx = {
    location: { directory },
    options: options ?? {},
    tool: {
      transform: async (callback: (target: ReturnType<typeof createFakeEditor>) => void) => {
        transforms.push(callback)
        const before = new Map(editor.tools)
        callback(editor)
        return {
          dispose: async () => {
            disposeCount += 1
            editor.tools.clear()
            for (const [id, tool] of before) editor.tools.set(id, tool)
          },
        }
      },
      list: async () => editor.list(),
    },
    session: { hook: session.hook },
  } as unknown as Parameters<typeof setupHashlinePlugin>[0]

  const cleanup = await setupHashlinePlugin(ctx, filesystem)
  return {
    tools: editor.tools,
    nativeCalls,
    cleanup,
    disposed: () => disposeCount > 0,
    hooksActive: session.activeCount,
    dispatchSurface: async (modelID, hookName = "context") => {
      const tools = surfaceRecord(editor.tools)
      builtinPatchGating(modelID, tools)
      const event = { model: { id: modelID }, tools }
      await session.deliver(hookName, event)
      return event.tools
    },
    replay: (withNative = true) => {
      const fresh = createFakeEditor()
      addFakeBuiltins(fresh)
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

test("tool descriptions require verbatim headers and discourage bypassing rejected edits", async () => {
  const harness = await createHarness({ directory: root })
  for (const tool of [readTool(harness.tools), editTool(harness.tools)]) {
    assert.match(tool.description, /entire `\[PATH#TAG\]` header.*verbatim/)
    assert.match(tool.description, /Never shorten an absolute path/)
    assert.match(tool.description, /Partial reads register valid Snapshots/)
    assert.match(tool.description, /Do not bypass.*write.*shell/)
  }
})

test("absolute reads recover from relative patch headers without rewriting the file", async () => {
  const absolutePath = path.join(root, "a.ts")
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const read = readTool(harness.tools)
  const edit = editTool(harness.tools)
  let header = ""
  for (const input of [{ path: absolutePath, limit: 1 }, { path: absolutePath }]) {
    const reading = await read.execute(input, CONTEXT)
    header = reading.metadata.header
    await assert.rejects(
      edit.execute({ patch: `[a.ts#${reading.metadata.tag}]\nreplace 1\n+ONE` }, CONTEXT),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotRequiredError)
        assert.equal(error.readHeader, header)
        assert.ok(error.message.split("\n").includes(header))
        assert.match(error.message, /path spelling/i)
        assert.deepEqual((error as AnyRecord).written, [])
        return true
      },
    )
    assert.equal(await readFile(absolutePath, "utf8"), "one\ntwo\n")
  }
  await edit.execute({ patch: `${header}\nreplace 1\n+ONE` }, CONTEXT)
  assert.equal(await readFile(absolutePath, "utf8"), "ONE\ntwo\n")
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

test("one patch applies every hunk against original line numbers across multiple files", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\nbeta\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) },
  })
  const read = readTool(harness.tools)
  const edit = editTool(harness.tools)
  const a = await read.execute({ path: "a.ts" }, CONTEXT)
  const b = await read.execute({ path: "b.ts" }, CONTEXT)
  const result = await edit.execute({ patch: [
    a.metadata.header,
    "insert before 1", "+head",
    "replace 1-2", "+- item", "++ item", "+",
    "insert after 2", "+tail",
    "append", "+end",
    b.metadata.header,
    "replace 2", "+BETA", "+more",
  ].join("\n") }, CONTEXT)

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "head\n- item\n+ item\n\ntail\nend\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "alpha\nBETA\nmore\n")
  assert.deepEqual(result.metadata.written, [path.join(root, "a.ts"), path.join(root, "b.ts")])
  assert.deepEqual(result.metadata.rolledBack, [])
  assert.deepEqual(result.metadata.partiallyWritten, [])
  assert.deepEqual(result.metadata.sections.map((section: AnyRecord) => section.firstChangedLine), [1, 2])
})

test("a failed second rename restores the first file from its pre-image", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\n")
  const filesystem = new FileSystemAdapter({
    root,
    rename: async (source, target) => {
      if (target === path.join(root, "b.ts")) throw new Error("injected rename failure")
      return rename(source, target)
    },
  })
  const harness = await createHarness({
    directory: root,
    filesystem,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) },
  })
  const a = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  const b = await readTool(harness.tools).execute({ path: "b.ts" }, CONTEXT)

  await assert.rejects(
    editTool(harness.tools).execute({ patch: `${a.metadata.header}\nreplace 1\n+ONE\n${b.metadata.header}\nreplace 1\n+ALPHA` }, CONTEXT),
    (error: unknown) => {
      const failure = error as AnyRecord
      assert.match(failure.message, /injected rename failure/)
      assert.deepEqual(failure.written, [path.join(root, "a.ts")])
      assert.deepEqual(failure.rolledBack, [path.join(root, "a.ts")])
      assert.deepEqual(failure.partiallyWritten, [])
      return true
    },
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "alpha\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "b.ts"])
})

test("a failed rollback reports the first file as partially written", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\n")
  let firstRenamed = false
  const harness = await createHarness({
    directory: root,
    filesystem: new FileSystemAdapter({
      root,
      rename: async (source, target) => {
        if (target === path.join(root, "b.ts") || (target === path.join(root, "a.ts") && firstRenamed)) {
          throw new Error("injected rename failure")
        }
        firstRenamed = true
        return rename(source, target)
      },
    }),
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) },
  })
  const a = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  const b = await readTool(harness.tools).execute({ path: "b.ts" }, CONTEXT)

  await assert.rejects(
    editTool(harness.tools).execute({ patch: `${a.metadata.header}\nreplace 1\n+ONE\n${b.metadata.header}\nreplace 1\n+ALPHA` }, CONTEXT),
    (error: unknown) => {
      const failure = error as AnyRecord
      assert.deepEqual(failure.written, [path.join(root, "a.ts")])
      assert.deepEqual(failure.rolledBack, [])
      assert.deepEqual(failure.partiallyWritten, [path.join(root, "a.ts")])
      assert.match(failure.message, /partiallyWritten=\[.*a\.ts\]/)
      return true
    },
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "ONE\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "alpha\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "b.ts"])
})

test("drift immediately before the second rename reports its Tag and rolls back the first file", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\n")
  const changed = "external\n"
  const harness = await createHarness({
    directory: root,
    filesystem: new class extends FileSystemAdapter {
      override async commitPrepared(prepared: Parameters<FileSystemAdapter["commitPrepared"]>[0]) {
        if (prepared.inputPath === "b.ts") await writeFile(path.join(root, "b.ts"), changed)
        return super.commitPrepared(prepared)
      }
    }({ root }),
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) },
  })
  const a = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  const b = await readTool(harness.tools).execute({ path: "b.ts" }, CONTEXT)
  await assert.rejects(editTool(harness.tools).execute({ patch: `${a.metadata.header}\nreplace 1\n+ONE\n${b.metadata.header}\nreplace 1\n+ALPHA` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof MismatchError)
    assert.equal(error.actualTag, computeTag(changed))
    assert.deepEqual((error as AnyRecord).written, [path.join(root, "a.ts")])
    assert.deepEqual((error as AnyRecord).rolledBack, [path.join(root, "a.ts")])
    assert.deepEqual((error as AnyRecord).partiallyWritten, [])
    return true
  })
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), changed)
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "b.ts"])
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

test("an unread alias cannot use a Snapshot minted for another path", async () => {
  await symlink(path.join(root, "a.ts"), path.join(root, "alias.ts"))
  const harness = await createHarness({
    directory: root,
    options: { enforceSeenLines: false },
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const reading = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  await assert.rejects(
    editTool(harness.tools).execute({ patch: `[alias.ts#${reading.metadata.tag}]\nreplace 1\n+unsafe` }, CONTEXT),
    (error: unknown) => error instanceof SnapshotRequiredError && error.readHeader === reading.metadata.header && /path spelling/i.test(error.message),
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("drift after preflight but before staging reports a fresh Tag and does not overwrite", async () => {
  const changed = "external\ntwo\n"
  const harness = await createHarness({
    directory: root,
    filesystem: new class extends FileSystemAdapter {
      override async prepareAtomic(input: Parameters<FileSystemAdapter["prepareAtomic"]>[0]) {
        await writeFile(path.join(root, "a.ts"), changed)
        return super.prepareAtomic(input)
      }
    }({ root }),
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const reading = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  await assert.rejects(editTool(harness.tools).execute({ patch: `${reading.metadata.header}\nreplace 1\n+ONE` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof MismatchError)
    assert.equal(error.actualTag, computeTag(changed))
    assert.match(error.message, /re-read/)
    assert.deepEqual((error as AnyRecord).written, [])
    return true
  })
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), changed)
  assert.deepEqual(await readdir(root), ["a.ts"])
})

test("two distinct read Snapshots with one colliding Tag cannot authorize an edit", async () => {
  const byTag = new Map<string, string>()
  let first = ""
  let second = ""
  for (let index = 0; index < 100_000 && !second; index += 1) {
    const text = `collision-${index}\n`
    const tag = computeTag(text)
    const previous = byTag.get(tag)
    if (previous && previous !== text) {
      first = previous
      second = text
    } else byTag.set(tag, text)
  }
  assert.ok(first && second)
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) },
  })
  await writeFile(path.join(root, "a.ts"), first)
  const reading = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  await writeFile(path.join(root, "a.ts"), second)
  const collision = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  assert.equal(reading.metadata.tag, collision.metadata.tag)
  await writeFile(path.join(root, "a.ts"), first)

  await assert.rejects(editTool(harness.tools).execute({ patch: `${reading.metadata.header}\nreplace 1\n+unsafe` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof MismatchError)
    assert.equal(error.actualTag, reading.metadata.tag)
    assert.match(error.message, /re-read/)
    assert.deepEqual((error as AnyRecord).written, [])
    return true
  })
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), first)
})

test("options evict old versions, old paths, and over-budget Snapshots without disabling freshness", async () => {
  await writeFile(path.join(root, "b.ts"), "other\n")
  const nativeRead = { execute: async (input: AnyRecord) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) }
  const versions = await createHarness({ directory: root, options: { maxVersionsPerPath: 1 }, nativeRead })
  const first = await readTool(versions.tools).execute({ path: "a.ts" }, CONTEXT)
  await writeFile(path.join(root, "a.ts"), "new\ntwo\n")
  await readTool(versions.tools).execute({ path: "a.ts" }, CONTEXT)
  await writeFile(path.join(root, "a.ts"), "one\ntwo\n")
  await assert.rejects(editTool(versions.tools).execute({ patch: `${first.metadata.header}\nreplace 1\n+unsafe` }, CONTEXT), (error: unknown) => error instanceof MismatchError)

  const paths = await createHarness({ directory: root, options: { maxPaths: 1 }, nativeRead })
  const a = await readTool(paths.tools).execute({ path: "a.ts" }, CONTEXT)
  await readTool(paths.tools).execute({ path: "b.ts" }, CONTEXT)
  await assert.rejects(editTool(paths.tools).execute({ patch: `${a.metadata.header}\nreplace 1\n+unsafe` }, CONTEXT), (error: unknown) => error instanceof MismatchError)

  const bytes = await createHarness({ directory: root, options: { maxTotalBytes: 7 }, nativeRead })
  await assert.rejects(readTool(bytes.tools).execute({ path: "a.ts" }, CONTEXT), /SnapshotStore limit/)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("preflight rejects a stale later section and a duplicate canonical path without writing", async () => {
  await writeFile(path.join(root, "b.ts"), "alpha\n")
  await symlink(path.join(root, "a.ts"), path.join(root, "alias.ts"))
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), await readFile(path.join(root, String(input.path)), "utf8")) },
  })
  const read = readTool(harness.tools)
  const edit = editTool(harness.tools)
  const a = await read.execute({ path: "a.ts" }, CONTEXT)
  const b = await read.execute({ path: "b.ts" }, CONTEXT)
  const alias = await read.execute({ path: "alias.ts" }, CONTEXT)
  await writeFile(path.join(root, "b.ts"), "changed\n")

  await assert.rejects(edit.execute({ patch: `${a.metadata.header}\nreplace 1\n+ONE\n${b.metadata.header}\nreplace 1\n+ALPHA` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof MismatchError)
    assert.equal(error.actualTag, computeTag("changed\n"))
    assert.match(error.message, /re-read/)
    assert.deepEqual((error as AnyRecord).written, [])
    return true
  })
  await assert.rejects(edit.execute({ patch: `${a.metadata.header}\nreplace 1\n+ONE\n${alias.metadata.header}\nreplace 2\n+TWO` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof DuplicatePathError)
    assert.deepEqual((error as AnyRecord).written, [])
    return true
  })
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.equal(await readFile(path.join(root, "b.ts"), "utf8"), "changed\n")
})

test("unsupported operations and no-op edits fail through the tool before writing", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const header = (await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)).metadata.header
  for (const operation of ["PUT 1", ".= 1", "CUT 1", "REM", "MV b.ts", "replace 1*", "@name"]) {
    await assert.rejects(editTool(harness.tools).execute({ patch: `${header}\n${operation}` }, CONTEXT), (error: unknown) => {
      assert.ok(error instanceof PatchSyntaxError)
      assert.match(error.message, /v1 alternative: replace N-M or replace N/)
      assert.deepEqual((error as AnyRecord).written, [])
      return true
    })
  }
  await assert.rejects(editTool(harness.tools).execute({ patch: `${header}\nreplace 1\n+one` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof NoChangesError)
    assert.match(error.message, /resulted in no changes/)
    return true
  })
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("edit preserves BOM and CRLF and writes a literal empty body line", async () => {
  await writeFile(path.join(root, "a.ts"), "\uFEFFone\r\ntwo\r\n")
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async () => nativeTextResult("a.ts", "one\ntwo\n") },
  })
  const reading = await readTool(harness.tools).execute({ path: "a.ts" }, CONTEXT)
  await editTool(harness.tools).execute({ patch: `${reading.metadata.header}\nreplace 2\n+` }, CONTEXT)
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "\uFEFFone\r\n\r\n")
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

test("relative escapes, absolute outside paths, and outward symlinks refuse read and edit without disclosure", async () => {
  const link = path.join(root, "escape.ts")
  await symlink(path.join(outside, "secret.ts"), link)
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "secret\n") },
  })
  const tag = computeTag("secret\n")
  const targets = [path.relative(root, path.join(outside, "secret.ts")), path.join(outside, "secret.ts"), "escape.ts"]
  for (const target of targets) {
    await assert.rejects(readTool(harness.tools).execute({ path: target }, CONTEXT), (error: unknown) => {
      assert.ok(error instanceof BoundaryError)
      assert.doesNotMatch(error.message, /File does not exist|secret\n/i)
      return true
    })
    await assert.rejects(editTool(harness.tools).execute({ patch: `[${target}#${tag}]\nreplace 1\n+leak` }, CONTEXT), (error: unknown) => {
      assert.ok(error instanceof BoundaryError)
      assert.deepEqual((error as AnyRecord).written, [])
      assert.doesNotMatch(error.message, /File does not exist|secret\n/i)
      return true
    })
  }
  assert.equal(harness.nativeCalls.length, 0)
  assert.equal(await readFile(path.join(outside, "secret.ts"), "utf8"), "secret\n")
})

test("a symlink switched outside after read or before rename cannot write beyond the Snapshot Root", async () => {
  const link = path.join(root, "link.ts")
  await symlink(path.join(root, "a.ts"), link)
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const read = await readTool(harness.tools).execute({ path: "link.ts" }, CONTEXT)
  await rm(link)
  await symlink(path.join(outside, "secret.ts"), link)
  await assert.rejects(editTool(harness.tools).execute({ patch: `${read.metadata.header}\nreplace 1\n+unsafe` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof BoundaryError)
    assert.deepEqual((error as AnyRecord).written, [])
    assert.doesNotMatch(error.message, /secret|exist/i)
    return true
  })

  await rm(link)
  await symlink(path.join(root, "a.ts"), link)
  const race = await createHarness({
    directory: root,
    filesystem: new class extends FileSystemAdapter {
      override async commitPrepared(prepared: Parameters<FileSystemAdapter["commitPrepared"]>[0]) {
        await rm(link)
        await symlink(path.join(outside, "secret.ts"), link)
        return super.commitPrepared(prepared)
      }
    }({ root }),
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const second = await readTool(race.tools).execute({ path: "link.ts" }, CONTEXT)
  await assert.rejects(editTool(race.tools).execute({ patch: `${second.metadata.header}\nreplace 1\n+unsafe` }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof BoundaryError)
    assert.deepEqual((error as AnyRecord).written, [])
    return true
  })
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
  assert.equal(await readFile(path.join(outside, "secret.ts"), "utf8"), "secret\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.ts", "link.ts"])
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
  assert.match(first.content, /^\[a\.ts#[0-9A-F]{4}\]\n1:one\nLines 1-1 shown; lines outside this range are NOT seen and cannot be edited until read\n\[Output truncated\. Continue reading with offset: 2\]$/)
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
  assert.match(result.content, /^\[a\.ts#[0-9A-F]{4}\]\n1:one\n2:two\nLines 1-2 shown; lines outside this range are NOT seen and cannot be edited until read\n\[Output truncated\. Continue reading with offset: 3\]$/)
  assert.deepEqual(result.metadata.seenLines, [1, 2])
  await assert.rejects(
    editTool(harness.tools).execute({ patch: `${result.metadata.header}\nreplace 3\n+THREE` }, CONTEXT),
    (error: unknown) => error instanceof SeenLinesError,
  )
})

test("a small maxTaggedReadBytes budget truncates the tagged window earlier", async () => {
  const line = "x".repeat(100)
  const text = `${Array.from({ length: 6 }, () => line).join("\n")}\n`
  await writeFile(path.join(root, "big.txt"), text)
  const nativeRead = { execute: async (input: AnyRecord) => nativeTextResult(String(input.path), text) }

  const full = await createHarness({ directory: root, nativeRead })
  const defaultRead = await readTool(full.tools).execute({ path: "big.txt" }, CONTEXT)
  assert.doesNotMatch(String(defaultRead.content), /Output truncated/)
  assert.deepEqual(defaultRead.metadata.seenLines, [1, 2, 3, 4, 5, 6])

  const cramped = await createHarness({ directory: root, options: { maxTaggedReadBytes: 320 }, nativeRead })
  const budgetRead = await readTool(cramped.tools).execute({ path: "big.txt" }, CONTEXT)
  assert.match(
    String(budgetRead.content),
    /^\[big\.txt#[0-9A-F]{4}\]\n1:x{100}\nLines 1-1 shown; lines outside this range are NOT seen and cannot be edited until read\n\[Output truncated\. Continue reading with offset: 2\]$/,
  )
  assert.deepEqual(budgetRead.metadata.seenLines, [1])

  const starved = await createHarness({ directory: root, options: { maxTaggedReadBytes: 200 }, nativeRead })
  const starvedRead = await readTool(starved.tools).execute({ path: "big.txt" }, CONTEXT)
  assert.match(
    String(starvedRead.content),
    /^\[big\.txt#[0-9A-F]{4}\]\nNo lines are shown; read the file to edit it\n\[Output truncated\. Continue reading with offset: 1\]$/,
  )
  assert.deepEqual(starvedRead.metadata.seenLines, [])
})

test("unseen Anchors reveal up to forty lines; truncated previews do not authorize retry", async () => {
  const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`)
  await writeFile(path.join(root, "a.ts"), `${lines.join("\n")}\n`)
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), `${lines.join("\n")}\n`) },
  })
  const reading = await readTool(harness.tools).execute({ path: "a.ts", limit: 1 }, CONTEXT)
  const edit = editTool(harness.tools)
  const truncatedPatch = `${reading.metadata.header}\nreplace 2-42\n+changed`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(edit.execute({ patch: truncatedPatch }, CONTEXT), (error: unknown) => {
      assert.ok(error instanceof SeenLinesError)
      assert.equal(error.revealed.length, 40)
      assert.equal(error.revealed[0].text, "line-2")
      assert.equal(error.truncated, true)
      assert.match(error.message, /Re-read the missing lines with offset 2 and retry/)
      assert.deepEqual((error as AnyRecord).written, [])
      return true
    })
  }
  const shortPatch = `${reading.metadata.header}\nreplace 2\n+TWO`
  await assert.rejects(edit.execute({ patch: shortPatch }, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof SeenLinesError)
    assert.deepEqual(error.revealed, [{ line: 2, text: "line-2" }])
    assert.equal(error.truncated, false)
    assert.match(error.message, /The missing lines are shown above; retry the edit now with the same header — no re-read needed/)
    return true
  })
  await edit.execute({ patch: shortPatch }, CONTEXT)
  assert.equal((await readFile(path.join(root, "a.ts"), "utf8")).split("\n")[1], "TWO")
  assert.equal(harness.nativeCalls.length, 1)
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
  assert.equal(lines.length, 2003)
  assert.match(lines[1], /^1:line-1$/)
  assert.match(lines[2000], /^2000:line-2000$/)
  assert.equal(lines[2001], "Lines 1-2000 shown; lines outside this range are NOT seen and cannot be edited until read")
  assert.equal(lines[2002], "[Output truncated. Continue reading with offset: 2001]")
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
    /retry the edit now with the same header/,
  )
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "one\ntwo\n")
})

test("two Locations get isolated snapshot stores and rootIds", async () => {
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

    const readB = await readTool(harnessB.tools).execute({ path: "a.ts" }, CONTEXT)
    assert.notEqual(readA.metadata.rootId, readB.metadata.rootId)

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

test("cleanup disposes the tool registration and returns the native tools", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  assert.equal(harness.disposed(), false)
  await harness.cleanup()
  assert.equal(harness.disposed(), true)
  assert.equal(harness.tools.get("read")?.description, "native read")
  assert.equal(harness.tools.has("edit"), false)
})

test("surface hooks expose hashline read/edit plus native write without patch on any model", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })

  const surface = await harness.dispatchSurface("probe-model")
  assert.deepEqual(Object.keys(surface).sort(), ["edit", "read", "write"])
  assert.match(surface.read.description, /entire `\[PATH#TAG\]` header.*verbatim/)
  assert.match(surface.edit.description, /hashline patch/)
  assert.equal(surface.edit.input, editTool(harness.tools).input)
  assert.equal(surface.write.description, NATIVE_WRITE_DESCRIPTION)
  assert.deepEqual(surface.write.input, NATIVE_WRITE_JSON)
})

test("gpt-family gating deletions are restored to the same surface by the plugin hook", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })

  const gated = surfaceRecord(harness.tools)
  builtinPatchGating("gpt-probe", gated)
  assert.deepEqual(Object.keys(gated).sort(), ["patch", "read"])

  const surface = await harness.dispatchSurface("gpt-probe")
  assert.deepEqual(Object.keys(surface).sort(), ["edit", "read", "write"])
  assert.match(surface.edit.description, /hashline patch/)
  assert.equal(surface.write.description, NATIVE_WRITE_DESCRIPTION)
  assert.deepEqual(await harness.dispatchSurface("probe-model"), surface)
})

test("surface hooks cover context, compaction, and generate and do not leak after unload", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })

  for (const name of ["context", "compaction", "generate"]) {
    const surface = await harness.dispatchSurface("gpt-probe", name)
    assert.deepEqual(Object.keys(surface).sort(), ["edit", "read", "write"], `hook ${name}`)
  }
  assert.equal(harness.hooksActive(), 3)

  await harness.cleanup()
  assert.equal(harness.hooksActive(), 0)
  const leaked = await harness.dispatchSurface("gpt-probe")
  assert.deepEqual(Object.keys(leaked).sort(), ["patch", "read"])
})

test("a tool missing from the registry is left off the surface instead of invented", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  harness.tools.delete("write")

  const surface = await harness.dispatchSurface("gpt-probe")
  assert.deepEqual(Object.keys(surface).sort(), ["edit", "read"])
})

test("a restored schema input with definitions keeps its $defs references resolvable", async () => {
  const harness = await createHarness({
    directory: root,
    nativeRead: { execute: async (input) => nativeTextResult(String(input.path), "one\ntwo\n") },
  })
  const write = harness.tools.get("write")
  assert.ok(write)
  harness.tools.set("write", { ...write, input: DEFINED_INPUT })

  const surface = await harness.dispatchSurface("gpt-probe")
  assert.deepEqual(surface.write.input, DEFINED_INPUT_JSON)
})

test("resolveHashlineSettings validates roots and defaults the rest", () => {
  const defaults = resolveHashlineSettings(undefined, root)
  assert.deepEqual(defaults, {
    enforceSeenLines: true,
    roots: [],
    maxPaths: 256,
    maxVersionsPerPath: 4,
    maxTotalBytes: 64 * 1024 * 1024,
    maxTaggedReadBytes: 40 * 1024,
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

  assert.throws(
    () => resolveHashlineSettings({ maxTaggedReadBytes: 0 }, root),
    /maxTaggedReadBytes must be a positive number/,
  )
  assert.throws(
    () => resolveHashlineSettings({ maxTaggedReadBytes: -40 }, root),
    /maxTaggedReadBytes must be a positive number/,
  )
  assert.equal(resolveHashlineSettings({ maxTaggedReadBytes: 1024 }, root).maxTaggedReadBytes, 1024)

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
