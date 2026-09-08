import path from "node:path"

import { tool } from "@opencode-ai/plugin"
import { HashlineService } from "./service.ts"
import type { EditResult, ReadResult } from "./service.ts"
import { InMemorySnapshotStore, SnapshotStoreLimits } from "./snapshots.ts"
import type { FileSystemAdapter } from "./filesystem.ts"

const processStores = new Map<string, InMemorySnapshotStore>()

interface HashlineDefaults {
  enabled: boolean
  enforceSeenLines: boolean
  roots: string[]
  maxPaths: number
  maxVersionsPerPath: number
  maxTotalBytes: number
}

const DEFAULT_CONFIG: HashlineDefaults = Object.freeze({
  enabled: true,
  enforceSeenLines: true,
  roots: [],
  maxPaths: SnapshotStoreLimits.maxPaths,
  maxVersionsPerPath: SnapshotStoreLimits.maxVersionsPerPath,
  maxTotalBytes: SnapshotStoreLimits.maxTotalBytes,
})

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

export interface HashlineToolResult {
  title: string
  output: string
  metadata: Record<string, unknown>
}

export interface HashlineToolDefinition {
  description: string
  args: unknown
  // Loose execute signature so tool consumers (and tests) can call with
  // partial contexts; the definitions themselves are built by `tool()`.
  execute: (args: any, context?: any) => Promise<any>
}

export interface HashlineHooks {
  tool: Record<string, HashlineToolDefinition>
  config: (config: unknown) => Promise<void>
}

export interface HashlinePluginInput {
  worktree?: string
  directory?: string
  config?: unknown
}

export interface HashlinePluginOptions {
  config?: unknown
  filesystem?: FileSystemAdapter
  store?: InMemorySnapshotStore
  toolFactory?: typeof tool
  enabled?: boolean
  enforceSeenLines?: boolean
  roots?: unknown
  maxPaths?: unknown
  maxVersionsPerPath?: unknown
  maxTotalBytes?: unknown
}

export interface HashlineSettings {
  enabled: boolean
  enforceSeenLines: boolean
  roots: string[]
  maxPaths: number
  maxVersionsPerPath: number
  maxTotalBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOption(options: HashlinePluginOptions, key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(options, key) &&
    (options as Record<string, unknown>)[key] !== undefined
  )
}

function configSection(config: unknown): Record<string, unknown> {
  if (!isRecord(config)) return {}
  return isRecord(config.hashline) ? config.hashline : config
}

function resolveConfiguredRoots(roots: unknown, worktree: string): string[] {
  if (roots === undefined) return [...DEFAULT_CONFIG.roots]
  if (!Array.isArray(roots)) throw new TypeError("hashline.roots must be an array")
  return roots.map((root) => {
    if (typeof root !== "string" || root.trim() === "") {
      throw new TypeError("hashline.roots must contain non-empty paths")
    }
    return path.isAbsolute(root) ? root : path.resolve(worktree, root)
  })
}

function resolveSettings(
  config: unknown,
  worktree: string,
  options: HashlinePluginOptions,
): HashlineSettings {
  const section = configSection(config)
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>
  const value = (key: string): unknown => {
    if (hasOption(options, key)) return (options as Record<string, unknown>)[key]
    return section[key] === undefined ? defaults[key] : section[key]
  }

  return {
    enabled: typeof value("enabled") === "boolean" ? (value("enabled") as boolean) : DEFAULT_CONFIG.enabled,
    enforceSeenLines:
      typeof value("enforceSeenLines") === "boolean"
        ? (value("enforceSeenLines") as boolean)
        : DEFAULT_CONFIG.enforceSeenLines,
    roots: resolveConfiguredRoots(value("roots"), worktree),
    maxPaths: value("maxPaths") as number,
    maxVersionsPerPath: value("maxVersionsPerPath") as number,
    maxTotalBytes: value("maxTotalBytes") as number,
  }
}

function processStoreFor(worktree: string, settings: HashlineSettings): InMemorySnapshotStore {
  const key = path.resolve(worktree)
  let store = processStores.get(key)
  if (!store) {
    store = new InMemorySnapshotStore({
      maxPaths: settings.maxPaths,
      maxVersionsPerPath: settings.maxVersionsPerPath,
      maxTotalBytes: settings.maxTotalBytes,
    })
    processStores.set(key, store)
  }
  return store
}

function serializableReadResult(result: ReadResult): Record<string, unknown> {
  return {
    path: result.path,
    canonicalPath: result.canonicalPath,
    rootId: result.rootId,
    header: result.header,
    numbered: result.numbered,
    warnings: result.warnings,
    tag: result.tag,
    seenLines: result.seenLines,
  }
}

function serializableEditResult(result: EditResult): Record<string, unknown> {
  return {
    sections: result.sections,
    written: result.written,
    rolledBack: result.rolledBack,
    partiallyWritten: result.partiallyWritten,
  }
}

export async function createHashlineHooks(
  input: HashlinePluginInput,
  options: HashlinePluginOptions = {},
): Promise<HashlineHooks> {
  const worktree = (input.worktree ?? input.directory) as string
  let settings = resolveSettings(options.config ?? input.config, worktree, options)
  let service: HashlineService | undefined
  let definitions: Record<string, HashlineToolDefinition> | undefined

  function getService(): HashlineService {
    service ??= new HashlineService({
      worktree,
      directory: input.directory ?? worktree,
      filesystem: options.filesystem,
      store: options.store ?? processStoreFor(worktree, settings),
      roots: settings.roots,
      maxPaths: settings.maxPaths,
      maxVersionsPerPath: settings.maxVersionsPerPath,
      maxTotalBytes: settings.maxTotalBytes,
      enforceSeenLines: settings.enforceSeenLines,
    })
    return service
  }

  async function getDefinitions(): Promise<Record<string, HashlineToolDefinition>> {
    if (definitions) return definitions
    const createTool = options.toolFactory ?? tool
    definitions = {
      read: createTool({
        description:
          "Read an existing file as [PATH#TAG] plus numbered lines. The Tag from this output is required for edit. Hashline edits only existing files; use the native write tool to create files. Hashline never formats or restyles code.",
        args: {
          path: createTool.schema.string().describe("Existing file path inside the Snapshot Root"),
          limit: createTool.schema.number().int().positive().optional().describe("Maximum lines to return"),
          offset: createTool.schema.number().int().positive().optional().describe("First 1-based line to return"),
        },
        async execute(args) {
          const result = await getService().read(args.path, args.limit, args.offset)
          return {
            title: result.path,
            output: result.output,
            metadata: serializableReadResult(result),
          }
        },
      }),
      edit: createTool({
        description: EDIT_DESCRIPTION,
        args: {
          patch: createTool.schema.string().describe("Hashline patch text"),
        },
        async execute(args) {
          const result = await getService().edit(args.patch)
          const output = result.sections
            .map((section) => `${section.header}\nfirstChangedLine: ${section.firstChangedLine}`)
            .join("\n")
          return {
            title: "hashline edit",
            output,
            metadata: serializableEditResult(result),
          }
        },
      }),
    }
    return definitions
  }

  const hooks: HashlineHooks = {
    tool: {},
    async config(config: unknown) {
      settings = resolveSettings(config, worktree, options)
      service = undefined
      const nextTools = settings.enabled ? await getDefinitions() : {}
      for (const name of Object.keys(hooks.tool)) delete hooks.tool[name]
      Object.assign(hooks.tool, nextTools)
    },
  }

  if (settings.enabled) Object.assign(hooks.tool, await getDefinitions())
  return hooks
}

export const HashlinePlugin = async (
  input: HashlinePluginInput,
  options: HashlinePluginOptions = {},
): Promise<HashlineHooks> => createHashlineHooks(input, options)

export default HashlinePlugin
