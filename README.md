# hashline-editing

OpenCode server plugin implementing tagged reads, guarded `replace`/insert edits,
per-process Snapshots, and a realpath-confined Snapshot Root.

The implementation is self-contained. It does not depend on or vendor
`@oh-my-pi/hashline`; OpenCode supplies `@opencode-ai/plugin` when the plugin is
loaded by the host.

## Install

```sh
mkdir -p <project>/.opencode/plugins
ln -s "$PWD/plugin/hashline.js" <project>/.opencode/plugins/hashline.js
```

## Verify

```sh
npm test
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
