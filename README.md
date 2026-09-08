# hashline-editing

OpenCode server plugin implementing tagged reads, guarded `replace`/insert edits,
per-process Snapshots, and a realpath-confined Snapshot Root.

The implementation is self-contained. It does not depend on or vendor
`@oh-my-pi/hashline`; OpenCode supplies `@opencode-ai/plugin` when the plugin is
loaded by the host.

## Why

Hashline editing fixes two common problems: search/replace blocks break on
duplicate code, and plain line numbers break when earlier edits shift lines.
Each `read` returns a `[PATH#TAG]` header. The tag identifies the exact file
version, so `edit` can check it before changing anything.

* **No line drift inside one patch:** all line numbers refer to the original
  Snapshot, so hunks never shift each other. For the next edit, use the new
  header returned by the previous one.
* **No wrong matches in repeated code:** edits address Snapshot line numbers,
  not text search, so duplicate lines like `return None` or `}` are safe. A
  stale or colliding tag is rejected instead of writing to the wrong place.
* **Fewer tokens:** a patch contains only the operation (`replace N-M`,
  `insert before|after N`, `append`) and the new lines. No surrounding context
  or old lines are needed.
* **Fail fast:** if the file changed on disk (another process, linter, or
  formatter), the tag check fails before anything is written. The model gets
  an error, re-reads, and retries.
* **Deterministic:** there is no fuzzy matching. The tag either matches the
  live file exactly, or the edit is rejected.

## Install

Add it to `plugin` in your `opencode.json` — OpenCode installs npm plugins automatically at startup:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@glaicer/supercode-hashline-editing"]
}
```

Restart OpenCode after saving.

## Verify

```sh
npm test
npm run typecheck
```

The plugin exposes tools named `read` and `edit`. Read a file first, then use
the returned `[PATH#TAG]` header with a patch such as:

```text
[src/a.ts#A1B2]
replace 2-3
+new line two
+new line three
```

Reads accept optional `limit` and `offset` windows. Inserts use `insert before N`,
`insert after N`, or `append`; all anchors use the original Snapshot line numbers.

A patch may contain multiple `[PATH#TAG]` sections. All sections pass preflight
validation before any target is changed; each file commits atomically, while
cross-file rollback is best effort and reported as `written`, `rolledBack`, and
`partiallyWritten`.

## Develop

Sources live in `src/*.ts` and compile to `dist/*.js` (gitignored) via Babel:

```sh
npm run build
npm run check:package
npm pack --dry-run
```
