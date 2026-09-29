# hashline-editing

An OpenCode plugin that edits files by line number instead of search and replace. Search and replace breaks when the same code shows up twice. Plain line numbers break when an earlier edit moves the lines below it.

The installation instructions below describe the released V1 package (`0.1.0`). This checkout contains an in-progress OpenCode V2 port; do not use the V1 commands below to install this development build. V2 packaging and migration instructions are tracked in ticket 05.

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
opencode plugin @glaicer/supercode-hashline-editing --global
```

- `--global` installs into the global config (`~/.config/opencode`); default is local (`.opencode` in the current project).
- `--force` replaces an already-installed version.
- Restart OpenCode after installing.

Manual install also works: add the package to the `plugin` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@glaicer/supercode-hashline-editing"]
}
```

Restart OpenCode after saving.
