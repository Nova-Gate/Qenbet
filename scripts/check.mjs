import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["server", "connectors", "scripts", "tests", "web"];
const skip = new Set(["node_modules", ".git", "runtime", "artifacts", ".runtime", ".cache", ".analysis"]);
const files = [];

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) files.push(full);
  }
}

for (const target of targets) await walk(join(root, target));
files.sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`syntax error: ${relative(root, file)}\n${result.stderr}`);
  }
}

if (failed) {
  console.error(`${failed} file(s) failed syntax checks.`);
  process.exit(1);
}
console.log(`${files.length} files passed syntax checks.`);
