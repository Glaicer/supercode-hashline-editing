import path from "node:path"
import { fileURLToPath } from "node:url"
import { realpath } from "node:fs/promises"

import { Schema } from "effect"
import { HashlineService } from "./service.ts"
import type { EditResult, ReadResult } from "./service.ts"
import { InMemorySnapshotStore, SnapshotStoreLimits } from "./snapshots.ts"
import { FileNotFoundError, isInside } from "./filesystem.ts"
import type { FileSystemAdapter } from "./filesystem.ts"
import { BoundaryError } from "./errors.ts"
import type { Info, Result, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"

const READ_NAME = "read"
const EDIT_NAME = "edit"
const WRITE_NAME = "write"
const PATCH_NAME = "patch"

const SURFACE_HOOK_NAMES = ["context", "compaction", "generate"] as const

const MAX_READ_LINES = 2_000
// shortcut: leave headroom under the host's default 50 KiB tool-output cap; revisit if the effective cap becomes available to plugins.
const MAX_TAGGED_READ_BYTES = 40 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const TRUNCATION_FOOTER = (next: number) => `[Output truncated. Continue reading with offset: ${next}]`

const READ_DESCRIPTION = [
  "Read the contents of a file or directory.",
  "Text files are returned as a `[PATH#TAG]` header followed by the requested lines, each prefixed by its 1-based absolute line number as `N:TEXT`; the prefix is for reference and is not part of the file content.",
  "Copy the entire `[PATH#TAG]` header from this output verbatim into edit; both PATH and TAG must remain exactly as returned.",
  "Never shorten an absolute path, normalize PATH, or reconstruct the header.",
  "Partial reads register valid Snapshots; only the displayed lines are marked as seen.",
  "Images and PDFs are presented directly to the model. Directory entries are returned one per line.",
  "Use offset and limit to read large files or directories in sections.",
  "Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  "Hashline edits only existing files; use the native write tool to create files.",
  "For existing files, use hashline edit. If edit rejects a patch, correct it using the diagnostic. Do not bypass a rejected edit with whole-file write or shell modification.",
  "Hashline never formats or restyles code.",
].join(" ")

const EDIT_DESCRIPTION = [
  "Apply a hashline patch to existing files.",
  "Each section starts with the entire `[PATH#TAG]` header copied from hashline read verbatim; both PATH and TAG must remain exactly as returned.",
  "Never shorten an absolute path, normalize PATH, or reconstruct the header.",
  "Partial reads register valid Snapshots; only the displayed lines are marked as seen.",
  "A patch may contain multiple sections, with one section per file and multiple hunks inside a section.",
  "Supported hunks are `replace N-M`, `replace N`, `insert before N`, `insert after N`, and `append`.",
  "Every body row starts with `+TEXT`; a single `+` means an empty line, `+- item` writes a literal `- item`, and `++ item` writes a literal `+ item`.",
  "Line numbers are from the original Snapshot, so hunks do not shift each other's addresses.",
  "Do not send `-old` deletion rows or context lines: send only the operation and replacement body.",
  "Hashline edits only existing files. NEVER format/restyle code; make only the requested exact changes.",
  "If edit rejects a patch, correct it using the diagnostic. Do not bypass a rejected edit with whole-file write or shell modification; use native write only to create files.",
].join(" ")

const READ_INPUT_FALLBACK = {
  type: "object",
  properties: {
    path: { type: "string", description: "File or directory to read" },
    offset: {
      type: "integer",
      minimum: 0,
      description: "The line or directory entry to start reading from (1-based)",
    },
    limit: {
      type: "integer",
      minimum: 0,
      description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const

const EDIT_INPUT = {
  type: "object",
  properties: {
    patch: { type: "string", description: "Hashline patch text; copy each entire [PATH#TAG] header from read verbatim, including its exact path spelling" },
  },
  required: ["patch"],
  additionalProperties: false,
} as const

export interface HashlinePluginSettings {
  enforceSeenLines: boolean
  roots: string[]
  maxPaths: number
  maxVersionsPerPath: number
  maxTotalBytes: number
}

const DEFAULT_SETTINGS: HashlinePluginSettings = Object.freeze({
  enforceSeenLines: true,
  roots: [],
  maxPaths: SnapshotStoreLimits.maxPaths,
  maxVersionsPerPath: SnapshotStoreLimits.maxVersionsPerPath,
  maxTotalBytes: SnapshotStoreLimits.maxTotalBytes,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readBoundary(directory: string, roots: string[]): (inputPath: string) => Promise<boolean> {
  return async (inputPath) => {
    let candidate = path.resolve(directory, inputPath)
    if (!roots.some((root) => isInside(root, candidate))) return false
    while (true) {
      try {
        const actual = await realpath(candidate)
        return roots.some((root) => isInside(root, actual))
      } catch (error) {
        if (!(error instanceof Error) || !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        const parent = path.dirname(candidate)
        if (parent === candidate) return false
        candidate = parent
      }
    }
  }
}

function resolveConfiguredRoots(roots: unknown, directory: string): string[] {
  if (roots === undefined) return [...DEFAULT_SETTINGS.roots]
  if (!Array.isArray(roots)) throw new TypeError("hashline roots must be an array")
  return roots.map((root) => {
    if (typeof root !== "string" || root.trim() === "") {
      throw new TypeError("hashline roots must contain non-empty paths")
    }
    return path.isAbsolute(root) ? root : path.resolve(directory, root)
  })
}

export function resolveHashlineSettings(raw: unknown, directory: string): HashlinePluginSettings {
  const options = isRecord(raw) ? raw : {}
  const numberOr = (key: "maxPaths" | "maxVersionsPerPath" | "maxTotalBytes"): number =>
    typeof options[key] === "number" ? (options[key] as number) : DEFAULT_SETTINGS[key]
  return {
    enforceSeenLines:
      typeof options.enforceSeenLines === "boolean"
        ? (options.enforceSeenLines as boolean)
        : DEFAULT_SETTINGS.enforceSeenLines,
    roots: resolveConfiguredRoots(options.roots, directory),
    maxPaths: numberOr("maxPaths"),
    maxVersionsPerPath: numberOr("maxVersionsPerPath"),
    maxTotalBytes: numberOr("maxTotalBytes"),
  }
}

export type SurfaceHookName = (typeof SURFACE_HOOK_NAMES)[number]

export interface SurfaceToolEntry {
  readonly description: string
  readonly input: unknown
}

export interface SurfaceEvent {
  tools: Record<string, SurfaceToolEntry>
}

export interface HashlineToolEntry extends SurfaceToolEntry {
  readonly id: string
}

export interface HashlinePluginInput {
  readonly location: { readonly directory: string }
  readonly options: unknown
  readonly tool: {
    readonly transform: (
      callback: (editor: ToolEditor) => void,
    ) => Promise<{ readonly dispose: () => Promise<void> }>
    readonly list: () => Promise<readonly HashlineToolEntry[]>
  }
  readonly session: {
    readonly hook: (
      name: SurfaceHookName,
      callback: (event: SurfaceEvent) => Promise<void> | void,
    ) => Promise<{ readonly dispose: () => Promise<void> }>
  }
}

type NativeToolResult = Result

type ReadToolInput = { path: string; offset?: number; limit?: number }
type EditToolInput = { patch: string }

interface TextReadWindow {
  readonly limit: number
  readonly truncated: boolean
  readonly next: number | undefined
}

function isNativeTextResult(native: NativeToolResult): boolean {
  const output = native.output
  if (!isRecord(output)) return false
  if (output.type === "list-page") return false
  if (output.type === "file" && output.encoding === "base64") return false
  return output.type === "file" || output.type === "text-page"
}

function clampLineText(text: string): string {
  return text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
}

function nativeTextWindow(native: NativeToolResult, input: ReadToolInput): TextReadWindow {
  const output = native.output
  if (!isRecord(output) || typeof output.content !== "string") return { limit: 0, truncated: false, next: undefined }
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  const emptyPage = output.type === "text-page" && output.content === "" && output.truncated !== true
  const lines = output.content === "" ? emptyPage ? [""] : [] : text.split("\n")
  const maximum = Math.min(input.limit || MAX_READ_LINES, MAX_READ_LINES, lines.length)
  const start = input.offset || 1
  let budget = MAX_TAGGED_READ_BYTES - Buffer.byteLength(`[${input.path}#FFFF]\n${TRUNCATION_FOOTER(999999999)}\n`)
  let limit = 0
  for (const line of lines.slice(0, maximum)) {
    const bytes = Buffer.byteLength(`${start + limit}:${clampLineText(line)}\n`)
    if (bytes > budget) break
    budget -= bytes
    limit += 1
  }
  const next = limit < lines.length ? start + limit : typeof output.next === "number" ? output.next : undefined
  return { limit, truncated: next !== undefined, next }
}

function clampNumberedLine(line: string): string {
  const colon = line.indexOf(":")
  if (colon < 0) return clampLineText(line)
  return `${line.slice(0, colon + 1)}${clampLineText(line.slice(colon + 1))}`
}

function serializableReadMetadata(result: ReadResult) {
  return {
    path: result.path,
    canonicalPath: result.canonicalPath,
    rootId: result.rootId,
    header: result.header,
    warnings: result.warnings,
    tag: result.tag,
    seenLines: result.seenLines,
  }
}

function outsideRootNote(inputPath: string, roots: string[]): string {
  return `Note: ${inputPath} is outside the Snapshot Root (roots: ${roots.join(", ")}); read natively without a Snapshot, so hashline edit is unavailable for this file.`
}

function withOutsideRootNote(native: NativeToolResult, inputPath: string, roots: string[]): NativeToolResult {
  const note = outsideRootNote(inputPath, roots)
  const content = native.content
  if (typeof content === "string") return { ...native, content: content === "" ? note : `${content}\n${note}` }
  if (Array.isArray(content)) return { ...native, content: [...content, { type: "text", text: note }] }
  return { ...native, content: note }
}

function serializableEditMetadata(result: EditResult) {
  return {
    sections: result.sections.map((section) => ({
      path: section.path,
      canonicalPath: section.canonicalPath,
      op: section.op,
      tag: section.tag,
      fileHash: section.fileHash,
      header: section.header,
      firstChangedLine: section.firstChangedLine,
      warnings: section.warnings,
    })),
    written: result.written,
    rolledBack: result.rolledBack,
    partiallyWritten: result.partiallyWritten,
  }
}

function makeReadTool({
  service,
  nativeRead,
  assertBoundary,
  roots,
}: {
  service: HashlineService
  nativeRead: (Info & { readonly id: string }) | undefined
  assertBoundary: (inputPath: string) => Promise<boolean>
  roots: string[]
}): Info {
  return {
    name: READ_NAME,
    options: { codemode: false },
    description: READ_DESCRIPTION,
    input: nativeRead?.input ?? READ_INPUT_FALLBACK,
    output: nativeRead?.output,
    async execute(input: ReadToolInput, context: ToolContext) {
      if (!nativeRead) {
        throw new Error(
          "hashline read: the host read tool is unavailable, so hashline refuses to read without its native executor",
        )
      }
      const insideRoot = await assertBoundary(input.path)
      const native = (await nativeRead.execute(input, context)) as NativeToolResult
      if (!insideRoot) return withOutsideRootNote(native, input.path, roots)
      if (!isNativeTextResult(native)) {
        if (!(await assertBoundary(input.path))) throw new BoundaryError(input.path, roots)
        return native
      }

      const output = native.output
      const { limit, truncated, next } = nativeTextWindow(native, input)
      let result: ReadResult
      try {
        result = await service.read(input.path, limit, input.offset, (line) => line.length <= MAX_LINE_LENGTH)
      } catch (error) {
        if (!(error instanceof FileNotFoundError)) throw error
        const uri = isRecord(output) && output.type === "file" ? output.uri : undefined
        const nativePath = typeof uri === "string" && uri.startsWith("file:")
          ? fileURLToPath(uri)
          : typeof native.content === "string"
            ? /^Read file (.*), (?:0 lines|lines \d+-\d+)$/.exec(native.content.split("\n")[0])?.[1]
            : undefined
        if (!nativePath || nativePath === input.path) throw error
        result = await service.read(nativePath, limit, input.offset, (line) => line.length <= MAX_LINE_LENGTH)
      }
      const lines = result.numbered === "" ? [] : result.numbered.split("\n").map(clampNumberedLine)
      const content =
        [result.header, ...lines].join("\n") +
        (truncated && next !== undefined ? `\n${TRUNCATION_FOOTER(next)}` : "")
      return { output, content, metadata: serializableReadMetadata(result) }
    },
  }
}

function makeEditTool({ service }: { service: HashlineService }): Info {
  return {
    name: EDIT_NAME,
    options: { codemode: false, permission: "edit" },
    description: EDIT_DESCRIPTION,
    input: EDIT_INPUT,
    async execute(input: EditToolInput, _context: ToolContext) {
      const result = await service.edit(input.patch)
      const content = result.sections
        .map((section) => `${section.header}\nfirstChangedLine: ${section.firstChangedLine}`)
        .join("\n")
      return { content, metadata: serializableEditMetadata(result) }
    },
  }
}

function surfaceInputJson(input: unknown): unknown {
  if (input === undefined || input === null) return {}
  if (!Schema.isSchema(input)) return input
  const document = Schema.toJsonSchemaDocument(input)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

function makeSurfaceHook(list: HashlinePluginInput["tool"]["list"]): (event: SurfaceEvent) => Promise<void> {
  return async (event) => {
    delete event.tools[PATCH_NAME]
    const listed = await list()
    for (const name of [EDIT_NAME, WRITE_NAME]) {
      if (event.tools[name]) continue
      const source = listed.find((tool) => tool.id === name)
      if (source) event.tools[name] = { description: source.description, input: surfaceInputJson(source.input) }
    }
  }
}

export async function setupHashlinePlugin(input: HashlinePluginInput, filesystem?: FileSystemAdapter): Promise<() => Promise<void>> {
  const directory = path.resolve(input.location.directory)
  const settings = resolveHashlineSettings(input.options, directory)
  const roots = await Promise.all([directory, ...settings.roots].map((root) => realpath(root)))
  const assertBoundary = readBoundary(directory, roots)
  const store = new InMemorySnapshotStore({
    maxPaths: settings.maxPaths,
    maxVersionsPerPath: settings.maxVersionsPerPath,
    maxTotalBytes: settings.maxTotalBytes,
  })
  const service = new HashlineService({
    worktree: directory,
    directory,
    roots: settings.roots,
    filesystem,
    store,
    enforceSeenLines: settings.enforceSeenLines,
  })

  const registration = await input.tool.transform((editor: ToolEditor) => {
    const nativeRead = editor.get(READ_NAME)
    editor.add(makeReadTool({ service, nativeRead, assertBoundary, roots }))
    editor.add(makeEditTool({ service }))
  })
  const surfaceHook = makeSurfaceHook(input.tool.list)
  const hookRegistrations = await Promise.all(
    SURFACE_HOOK_NAMES.map((name) => input.session.hook(name, surfaceHook)),
  )
  return async () => {
    await registration.dispose()
    for (const hookRegistration of hookRegistrations) await hookRegistration.dispose()
  }
}
