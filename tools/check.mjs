import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = [];
const markupFiles = [];
const exportCount = validateIndexExports();
validatePackageExports();
walk(root);
const localReferenceCount = validateLocalReferences();

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  `checked ${files.length} JavaScript modules, ${exportCount} public entry exports, `
  + `and ${localReferenceCount} local document references`,
);

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

function validatePackageExports() {
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const missing = [];
  for (const [name, target] of Object.entries(packageJson.exports ?? {})) {
    if (typeof target !== "string" || !target.startsWith("./")) {
      missing.push(`${name}: invalid local target ${String(target)}`);
      continue;
    }
    if (!existsSync(resolve(root, target))) missing.push(`${name}: missing ${target}`);
  }
  if (missing.length) {
    console.error(`package.json exports are invalid:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
    process.exit(1);
  }
}

function validateLocalReferences() {
  const failures = [];
  let count = 0;

  for (const file of markupFiles.sort()) {
    const source = readFileSync(file, "utf8");
    const isHtml = file.endsWith(".html");
    const expression = isHtml
      ? /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi
      : /!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^)]*["'])?\)/g;

    for (const match of source.matchAll(expression)) {
      const reference = match[1];
      if (isExternalReference(reference)) continue;
      count += 1;

      const path = reference.split(/[?#]/, 1)[0];
      if (!path) continue;

      let decodedPath;
      try {
        decodedPath = decodeURIComponent(path);
      } catch {
        failures.push(`${relative(root, file)}: invalid encoded path ${reference}`);
        continue;
      }

      if (decodedPath.startsWith("/")) {
        failures.push(`${relative(root, file)}: root-absolute local reference ${reference}`);
        continue;
      }

      const target = resolve(dirname(file), decodedPath);
      const rootRelativeTarget = relative(root, target);
      if (rootRelativeTarget === ".." || rootRelativeTarget.startsWith(`..${sep}`)) {
        failures.push(`${relative(root, file)}: reference leaves repository ${reference}`);
        continue;
      }

      const resolvedTarget = isHtml && decodedPath.endsWith("/") ? join(target, "index.html") : target;
      if (!existsSync(resolvedTarget)) {
        failures.push(`${relative(root, file)}: missing local reference ${reference}`);
      }
    }
  }

  if (failures.length) {
    console.error(`Local document references are invalid:\n${failures.map((entry) => `- ${entry}`).join("\n")}`);
    process.exit(1);
  }
  return count;
}

function isExternalReference(reference) {
  return reference === ""
    || reference.startsWith("#")
    || reference.startsWith("//")
    || /^[a-z][a-z\d+.-]*:/i.test(reference);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
    } else {
      if (/\.(?:mjs|js)$/.test(entry)) files.push(path);
      if (/\.(?:html|md)$/.test(entry)) markupFiles.push(path);
    }
  }
}
