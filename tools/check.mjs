import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
const exportCount = validateIndexExports();
walk(root);

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`checked ${files.length} JavaScript modules and ${exportCount} public entry exports`);

function validateIndexExports() {
  const indexPath = join(root, "index.js");
  const source = readFileSync(indexPath, "utf8");
  const missing = [];
  let count = 0;
  for (const match of source.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+"(\.\/[^\"]+)"/g)) {
    count += 1;
    const target = resolve(dirname(indexPath), match[1]);
    if (!existsSync(target)) missing.push(match[1]);
  }
  if (missing.length) {
    console.error(`index.js exports missing modules:\n${missing.map((path) => `- ${path}`).join("\n")}`);
    process.exit(1);
  }
  return count;
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
    } else if (/\.(?:mjs|js)$/.test(entry)) {
      files.push(path);
    }
  }
}
