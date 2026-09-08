import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const target = manifest.exports?.["."];

assert.equal(target, "./dist/hashline.js", "root export must be compiled JavaScript");
assert.equal(manifest.exports?.["./server"], "./dist/hashline.js", "server export must resolve to the hashline entry");

const compiled = [
  "./dist/hashline.js",
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

const entryCode = readFileSync(resolve(root, "./dist/hashline.js"), "utf8");
assert.match(entryCode, /export default /, "compiled entry must keep a default export for loaders that require one");

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
assert.ok(!files.some((file) => file.endsWith(".ts")), "tarball must not include raw sources");

console.log("package artifact: compiled JS only");
