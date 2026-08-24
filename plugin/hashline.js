import { HashlineService } from "../src/service.js"
import { InMemorySnapshotStore, SnapshotStoreLimits } from "../src/snapshots.js"

const processStore = new InMemorySnapshotStore(SnapshotStoreLimits)

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
  { toolFactory, store = processStore, filesystem, enforceSeenLines = true } = {},
) {
  const createTool = toolFactory ?? (await hostTool())
  const worktree = input.worktree ?? input.directory
  const service = new HashlineService({
    worktree,
    directory: input.directory ?? worktree,
    filesystem,
    store,
    enforceSeenLines,
  })

  return {
    tool: {
      read: createTool({
        description:
          "Read an existing file as [PATH#TAG] plus numbered lines. The TAG is required by the hashline edit tool; hashline never creates files, formats code, or restyles it.",
        args: {
          path: createTool.schema.string().describe("Existing file path inside the Snapshot Root"),
          limit: createTool.schema.number().int().positive().optional().describe("Maximum lines to return"),
          offset: createTool.schema.number().int().positive().optional().describe("First 1-based line to return"),
        },
        async execute(args) {
          const result = await service.read(args.path, args.limit, args.offset)
          return {
            title: result.path,
            output: result.output,
            metadata: serializableReadResult(result),
          }
        },
      }),
      edit: createTool({
        description:
          "Apply a hashline patch containing one or more [PATH#TAG] sections and replace N-M / replace N / insert before N / insert after N / append hunks. Use the TAG from hashline read; edit only existing files and NEVER format or restyle code. Preparation is preflight atomic; each file commits atomically; cross-file rollback is best effort and reported.",
        args: {
          patch: createTool.schema.string().describe("Hashline patch text"),
        },
        async execute(args) {
          const result = await service.edit(args.patch)
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
    },
  }
}

export const HashlinePlugin = async (input, options) => createHashlineHooks(input, options)

export default HashlinePlugin
