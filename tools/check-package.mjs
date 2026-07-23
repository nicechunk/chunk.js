import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "chunk-js-pack-"));

try {
  const packed = run(npmCommand(), [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryDirectory,
  ], root);
  const report = JSON.parse(packed.stdout);
  const artifact = report[0];
  if (!artifact?.filename || !Array.isArray(artifact.files)) {
    throw new Error("npm pack did not return a file manifest.");
  }

  const paths = new Set(artifact.files.map((entry) => entry.path));
  const invalid = [...paths].filter((path) => !allowedPackagePath(path));
  if (invalid.length) {
    throw new Error(`npm package contains files outside the allowlist:\n${invalid.map((path) => `- ${path}`).join("\n")}`);
  }

  const missingExports = [];
  for (const [name, target] of Object.entries(packageJson.exports ?? {})) {
    if (typeof target !== "string" || !target.startsWith("./")) continue;
    const path = target.slice(2);
    if (!paths.has(path)) missingExports.push(`${name}: ${path}`);
  }
  if (missingExports.length) {
    throw new Error(`npm package omits public export targets:\n${missingExports.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const archive = join(temporaryDirectory, artifact.filename);
  run(npmCommand(), [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--package-lock=false",
    archive,
  ], temporaryDirectory);
  const installedPackage = join(temporaryDirectory, "node_modules", ...packageJson.name.split("/"));
  await access(installedPackage);
  const packedReferenceCount = await validatePackedMarkdownReferences(installedPackage, paths);
  const specifiers = Object.keys(packageJson.exports ?? {}).map((subpath) => (
    subpath === "." ? packageJson.name : `${packageJson.name}${subpath.slice(1)}`
  ));
  const verifierPath = join(temporaryDirectory, ".verify-exports.mjs");
  await writeFile(verifierPath, [
    `const specifiers = ${JSON.stringify(specifiers)};`,
    "for (const specifier of specifiers) await import(specifier);",
    "process.stdout.write(String(specifiers.length));",
  ].join("\n"));
  const verified = run(process.execPath, [verifierPath], temporaryDirectory);
  const importedCount = Number(verified.stdout.trim());
  if (importedCount !== specifiers.length) throw new Error("Packed export verification returned an unexpected result.");

  console.log(
    `package artifact check passed for ${paths.size} files, ${artifact.size} packed bytes, `
    + `${importedCount} exports, and ${packedReferenceCount} local Markdown references`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function allowedPackagePath(path) {
  if ([
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "package.json",
    "index.js",
    "play.js",
  ].includes(path)) return true;
  if (/^docs\/[^/]+\.md$/.test(path)) return true;
  if (/^debug\/[^/]+\.js$/.test(path)) return true;
  return /^(?:chunk|construction|core|engine|forge|input|ncm|physics|renderer|src|world)\/.+\.js$/.test(path);
}

async function validatePackedMarkdownReferences(packageDirectory, paths) {
  const failures = [];
  let count = 0;
  for (const path of [...paths].filter((entry) => entry.endsWith(".md")).sort()) {
    const file = join(packageDirectory, path);
    const source = await readFile(file, "utf8");
    const expression = /!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^)]*["'])?\)/g;
    for (const match of source.matchAll(expression)) {
      const reference = match[1];
      if (isExternalReference(reference)) continue;
      count += 1;
      const encodedPath = reference.split(/[?#]/, 1)[0];
      if (!encodedPath) continue;

      let decodedPath;
      try {
        decodedPath = decodeURIComponent(encodedPath);
      } catch {
        failures.push(`${path}: invalid encoded path ${reference}`);
        continue;
      }
      if (isAbsolute(decodedPath)) {
        failures.push(`${path}: absolute local reference ${reference}`);
        continue;
      }

      const target = resolve(dirname(file), decodedPath);
      const packageRelativeTarget = relative(packageDirectory, target);
      if (packageRelativeTarget === ".." || packageRelativeTarget.startsWith(`..${sep}`)) {
        failures.push(`${path}: reference leaves the installed package ${reference}`);
        continue;
      }
      try {
        await access(target);
      } catch {
        failures.push(`${path}: missing from installed package ${reference}`);
      }
    }
  }
  if (failures.length) {
    throw new Error(`Installed package Markdown references are invalid:\n${failures.map((entry) => `- ${entry}`).join("\n")}`);
  }
  return count;
}

function isExternalReference(reference) {
  return reference === ""
    || reference.startsWith("#")
    || reference.startsWith("//")
    || /^[a-z][a-z\d+.-]*:/i.test(reference);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with exit code ${result.status}.`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
