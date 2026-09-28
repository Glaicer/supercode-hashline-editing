import path from "node:path"
import { fileURLToPath } from "node:url"
import { realpath } from "node:fs/promises"

import { HashlineService } from "./service.ts"
import type { EditResult, ReadResult } from "./service.ts"
import { InMemorySnapshotStore, SnapshotStoreLimits } from "./snapshots.ts"
import { FileNotFoundError, isInside } from "./filesystem.ts"
import { BoundaryError } from "./errors.ts"
import type { Info, Result, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"

const READ_NAME = "read"
const EDIT_NAME = "edit"

const MAX_READ_LINES = 2_000
// shortcut: leave headroom under the host's default 50 KiB tool-output cap; revisit if the effective cap becomes available to plugins.
const MAX_TAGGED_READ_BYTES = 40 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const TRUNCATION_FOOTER = (next: number) => `[Output truncated. Continue reading with offset: ${next}]`

const READ_DESCRIPTION = [
  "Read the contents of a file or directory.",
  "Text files are returned as a `[PATH#TAG]` header followed by the requested lines, each prefixed by its 1-based absolute line number as `N:TEXT`; the prefix is for reference and is not part of the file content.",
  "The Tag from this output is required by the edit tool.",
  "Images and PDFs are presented directly to the model. Directory entries are returned one per line.",
  "Use offset and limit to read large files or directories in sections.",
  "Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  "Hashline edits only existing files; use the native write tool to create files.",
  "Hashline never formats or restyles code.",
].join(" ")

const EDIT_DESCRIPTION = [
  "Apply a hashline patch to existing files.",
  "Each section starts with `[PATH#TAG]`, where Tag must come from the hashline read output.",
  "A patch may contain multiple sections, with one section per file and multiple hunks inside a section.",
  "Supported hunks are `replace N-M`, `replace N`, `insert before N`, `insert after N`, and `append`.",
  "Every body row starts with `+TEXT`; a single `+` means an empty line, `+- item` writes a literal `- item`, and `++ item` writes a literal `+ item`.",
  "Line numbers are from the original Snapshot, so hunks do not shift each other's addresses.",
  "Do not send `-old` deletion rows or context lines: send only the operation and replacement body.",
  "Hashline edits only existing files. NEVER format/restyle code; make only the requested exact changes.",
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
    patch: { type: "string", description: "Hashline patch text" },
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

function readBoundary(directory: string, roots: string[]): (inputPath: string) => Promise<void> {
  return async (inputPath) => {
    let candidate = path.resolve(directory, inputPath)
    if (!roots.some((root) => isInside(root, candidate))) throw new BoundaryError()
    while (true) {
      try {
        const actual = await realpath(candidate)
        if (!roots.some((root) => isInside(root, actual))) throw new BoundaryError()
        return
      } catch (error) {
        if (!(error instanceof Error) || !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        const parent = path.dirname(candidate)
        if (parent === candidate) throw new BoundaryError()
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

export interface HashlinePluginInput {
  readonly location: { readonly directory: string }
  readonly options: unknown
  readonly tool: {
    readonly transform: (
      callback: (editor: ToolEditor) => void,
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
}: {
  service: HashlineService
  nativeRead: (Info & { readonly id: string }) | undefined
  assertBoundary: (inputPath: string) => Promise<void>
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
      await assertBoundary(input.path)
      const native = (await nativeRead.execute(input, context)) as NativeToolResult
      if (!isNativeTextResult(native)) {
        await assertBoundary(input.path)
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

export async function setupHashlinePlugin(input: HashlinePluginInput): Promise<() => Promise<void>> {
  const directory = path.resolve(input.location.directory)
  const settings = resolveHashlineSettings(input.options, directory)
  const assertBoundary = readBoundary(directory, await Promise.all([directory, ...settings.roots].map((root) => realpath(root))))
  const store = new InMemorySnapshotStore({
    maxPaths: settings.maxPaths,
    maxVersionsPerPath: settings.maxVersionsPerPath,
    maxTotalBytes: settings.maxTotalBytes,
  })
  const service = new HashlineService({
    worktree: directory,
    directory,
    roots: settings.roots,
    store,
    enforceSeenLines: settings.enforceSeenLines,
  })

  const registration = await input.tool.transform((editor: ToolEditor) => {
    const nativeRead = editor.get(READ_NAME)
    editor.add(makeReadTool({ service, nativeRead, assertBoundary }))
    editor.add(makeEditTool({ service }))
  })
  return () => registration.dispose()
}
