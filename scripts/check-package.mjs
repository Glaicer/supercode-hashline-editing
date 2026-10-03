import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os"
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

assert.equal(manifest.exports?.["."], "./dist/index.js", "root export must be the V2 entry");
assert.equal(manifest.main, "./dist/index.js", "main must be the V2 entry");
assert.equal(manifest.engines?.opencode, ">=2.0.0", "package must declare V2 hosts only");

function hostVersion() {
  for (const bin of ["opencode", `${homedir()}/.opencode/bin/opencode`]) {
    try {
      return /v?(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ["--version"], { encoding: "utf8" }))?.[1];
    } catch {}
  }
  return undefined;
}

const host = hostVersion();
assert.ok(host, "opencode host must be installed to verify the plugin pin");
const hostPin = manifest.dependencies?.["@opencode/plugin"];
assert.equal(
  hostPin,
  host,
  `@opencode/plugin pin ${hostPin} must equal the running host ${host}; bump the pin and re-verify per the "Pins verified" note in package.json`,
);

const compiled = [
  "./dist/index.js",
  "./dist/plugin.js",
  "./dist/service.js",
  "./dist/parser.js",
  "./dist/snapshots.js",
  "./dist/filesystem.js",
  "./dist/hash.js",
  "./dist/errors.js",
];

for (const entry of compiled) {
  const code = readFileSync(resolve(root, entry), "utf8");
  assert.doesNotMatch(code, /from ["'][^"']+\.ts["']/, `compiled ${entry} must not import TypeScript`);
}

const entryCode = readFileSync(resolve(root, "./dist/index.js"), "utf8");
assert.match(entryCode, /Plugin\.define/, "compiled entry must define the plugin through the V2 package");
const rootEntry = readFileSync(resolve(root, "./index.js"), "utf8");
assert.match(rootEntry, /export \{ default \} from "\.\/dist\/index\.js"/, "root entry must re-export the compiled entry");

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const pack = Array.isArray(packed) ? packed[0] : (packed[manifest.name] ?? Object.values(packed)[0]);
const files = pack.files.map((file) => file.path);

for (const entry of compiled) {
  assert.ok(files.includes(entry.replace(/^\.\//, "")), `tarball must include ${entry}`);
}
assert.ok(files.includes("index.js"), "tarball must include the host-resolvable root entry");
assert.ok(!files.some((file) => file.endsWith(".ts")), "tarball must not include raw sources");

console.log("package artifact: compiled V2 plugin JS only");
