# hashline-editing

An OpenCode plugin that edits files by line number instead of search and replace. Search and replace breaks when the same code shows up twice. Plain line numbers break when an earlier edit moves the lines below it.

Version `1.0.0` targets OpenCode V2 (2.x). The V1 release (`0.1.0`) stays as-is for OpenCode 1.x hosts; the two are separate artifacts and nothing migrates automatically.

## What it does

Each `read` returns a `[PATH#TAG]` header. The tag names the exact version you read, so `edit` can check it before it writes.

Read a file first, then send a patch like this:

```text
[src/a.ts#A1B2]
replace 2-3
+new line two
+new line three
```

Reads take `limit` and `offset`. For inserts use `insert before N`, `insert after N`, or `append`. One patch can cover several files. Every file is checked first, then written.

## Benefits

- Edits in one patch never shift each other. Line numbers refer to the version you read. Use the new header for the next edit.
- Duplicate lines are safe because you point at lines, not text. A stale tag stops instead of writing to the wrong place.
- Patches stay small. You send only the operation and the new lines, no surrounding context.
- If the file changed on disk, the edit stops before writing anything. Read again and retry.
- No fuzzy matching. The tag either matches or it does not.

## WARNING: edit permissions are not enforced

Hashline `edit` cannot ask OpenCode for permission at write time — the plugin API has no such mechanism (`ctx.permission` can list and answer requests, not create them). Unlike the native `edit` and `write` tools, which do park for approval, hashline writes directly. Measured on OpenCode 2.0.18:

- `edit: ask` rules do **not** park for approval. Every hashline edit is treated as `allow` and writes immediately.
- `edit: deny` rules naming paths (for example `**/src/secrets/**`) are **not** enforced. A blanket `edit: deny *` blocks hashline edits, but only because OpenCode hides the tool from the model entirely — it is not a check inside `edit`.
- `read` is unaffected: it delegates to the native read tool, which honors `read` permissions as usual.

If you rely on edit approvals or path-scoped edit denials, do not use this plugin for those files — or wrap the workflow in your own review process. Use at your own risk.

The Snapshot Root boundary still confines every read and edit to the project root and configured `roots`, and a stale tag still refuses to write. Those protect against writing outside the root and to the wrong version of a file; they are not an approval policy.

## Install

Install with the OpenCode CLI:

```bash
opencode plugin add @glaicer/supercode-hashline-editing
```

This exact command was verified on OpenCode 2.0.18. It installs the package into OpenCode's plugin cache and appends the bare package name to the `plugins` array of your global OpenCode config (`~/.config/opencode/opencode.json` or `opencode.jsonc`). Then restart OpenCode — config is only read when a location boots, so already-running sessions keep their old tool surface.

## Settings and migrating from V1

Options travel inside the `plugins` entry of the global config. `opencode plugin add` writes the bare package name; to set options, expand that entry to the object form shown below. Every option is optional, and the defaults match V1:

| option | default | meaning |
| --- | --- | --- |
| `enforceSeenLines` | `true` | refuse to edit lines a `read` never showed |
| `roots` | `[]` | additional Snapshot Roots besides the project root |
| `maxPaths` | `256` | tracked-file limit of the snapshot store |
| `maxVersionsPerPath` | `4` | remembered versions per file |
| `maxTotalBytes` | `67108864` | total snapshot budget in bytes |

Before — V1 (`0.1.0`) read a `hashline` section of the config (OpenCode 1.x):

```jsonc
{
  "hashline": {
    "enabled": true,
    "enforceSeenLines": true,
    "roots": [],
    "maxPaths": 256,
    "maxVersionsPerPath": 4,
    "maxTotalBytes": 67108864
  }
}
```

After — V2 (`1.0.0`) takes the same values as `options` of the `plugins` entry; the `hashline` section is no longer read, so delete it:

```jsonc
{
  "plugins": [
    {
      "package": "@glaicer/supercode-hashline-editing",
      "options": {
        "enforceSeenLines": true,
        "roots": [],
        "maxPaths": 256,
        "maxVersionsPerPath": 4,
        "maxTotalBytes": 67108864
      }
    }
  ]
}
```

## Disable

The `enabled` flag is gone. To turn the plugin off, remove its entry from `plugins` and restart the location (boot a fresh session). Config edits never reach already-running locations, so the restart is required; afterwards the native `read`/`edit`/`patch` tools are back.

## Differences from the native edit tools

- **Only existing files.** Hashline `edit` patches files that exist and were read. Creating a file is the native `write` tool's job.
- **No formatting.** The native `edit` and `write` tools run the configured formatter after writing; hashline `edit` writes exactly the lines you asked for and never formats or restyles code.
- **No edit approval.** Hashline `edit` writes without asking. See the WARNING above before relying on edit permissions.
