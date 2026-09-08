import { transformAsync } from "@babel/core";
import presetTypeScript from "@babel/preset-typescript";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "src");
const outputDir = join(root, "dist");

function rewriteTypeScriptExtensions() {
  const rewrite = (path) => {
    const source = path.node.source;
    if (!source?.value.startsWith(".")) return;
    source.value = source.value.replace(/\.tsx?$/, ".js");
  };

  return {
    visitor: {
      ExportAllDeclaration: rewrite,
      ExportNamedDeclaration: rewrite,
      ImportDeclaration: rewrite,
    },
  };
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const files = (await readdir(sourceDir)).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);

for (const file of files) {
  const input = join(sourceDir, file);
  const source = await readFile(input, "utf8");

  const result = await transformAsync(source, {
    filename: input,
    configFile: false,
    babelrc: false,
    plugins: [rewriteTypeScriptExtensions],
    presets: [[presetTypeScript]],
  });
  if (!result?.code) throw new Error(`build: Babel produced no output for ${file}`);

  const target = join(outputDir, `${file.slice(0, -extname(file).length)}.js`);
  await writeFile(target, `${result.code}\n`);
}
