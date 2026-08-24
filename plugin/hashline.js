import path from "node:path"

import { HashlineService } from "../src/service.js"
import { InMemorySnapshotStore, SnapshotStoreLimits } from "../src/snapshots.js"

const processStores = new Map()

const DEFAULT_CONFIG = Object.freeze({
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

function fallbackSchemaNode(type) {
  return {
    type,
    describe(description) {
      this.description = description
      return this
    },
    optional() {
      this.isOptional = true
      return this
    },
    int() {
      return this
    },
    positive() {
      return this
    },
  }
}

function fallbackTool(input) {
  return input
}

fallbackTool.schema = {
  string: () => fallbackSchemaNode("string"),
  number: () => fallbackSchemaNode("number"),
}

async function hostTool() {
  try {
    return (await import("@opencode-ai/plugin")).tool
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
    return fallbackTool
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined
}

function configSection(config) {
  if (!isRecord(config)) return {}
  return isRecord(config.hashline) ? config.hashline : config
}

function resolveConfiguredRoots(roots, worktree) {
  if (roots === undefined) return [...DEFAULT_CONFIG.roots]
  if (!Array.isArray(roots)) throw new TypeError("hashline.roots must be an array")
  return roots.map((root) => {
    if (typeof root !== "string" || root.trim() === "") {
      throw new TypeError("hashline.roots must contain non-empty paths")
    }
    return path.isAbsolute(root) ? root : path.resolve(worktree, root)
  })
}

function resolveSettings(config, worktree, options) {
  const section = configSection(config)
  const value = (key) => {
    if (hasOption(options, key)) return options[key]
    return section[key] === undefined ? DEFAULT_CONFIG[key] : section[key]
  }

  return {
    enabled: typeof value("enabled") === "boolean" ? value("enabled") : DEFAULT_CONFIG.enabled,
    enforceSeenLines:
      typeof value("enforceSeenLines") === "boolean"
        ? value("enforceSeenLines")
        : DEFAULT_CONFIG.enforceSeenLines,
    roots: resolveConfiguredRoots(value("roots"), worktree),
    maxPaths: value("maxPaths"),
    maxVersionsPerPath: value("maxVersionsPerPath"),
    maxTotalBytes: value("maxTotalBytes"),
  }
}

function processStoreFor(worktree, settings) {
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

function serializableReadResult(result) {
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

function serializableEditResult(result) {
  return {
    sections: result.sections,
    written: result.written,
    rolledBack: result.rolledBack,
    partiallyWritten: result.partiallyWritten,
  }
}

export async function createHashlineHooks(
  input,
  options = {},
) {
  const worktree = input.worktree ?? input.directory
  let settings = resolveSettings(options.config ?? input.config, worktree, options)
  let service
  let definitions

  function getService() {
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

  async function getDefinitions() {
    if (definitions) return definitions
    const createTool = options.toolFactory ?? (await hostTool())
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

  const hooks = {
    tool: {},
    async config(config) {
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

export const HashlinePlugin = async (input, options) => createHashlineHooks(input, options)

export default HashlinePlugin
