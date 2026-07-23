import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testsDirectory = join(root, "tests");
const hostIntegrationDirectory = join(testsDirectory, "host-integration");
const hostIntegrationManifestFile = join(hostIntegrationDirectory, "manifest.json");
const mode = process.argv[2] ?? "--standalone";
const supportedModes = new Set(["--standalone", "--integration", "--all"]);

if (!supportedModes.has(mode) || process.argv.length > 3) {
  console.error("Usage: node tools/run-tests.mjs [--standalone|--integration|--all]");
  process.exit(2);
}

const tests = discoverTests(testsDirectory);
const testsByPath = new Map(tests.map((test) => [test.path, test]));
const integrationManifest = loadIntegrationManifest(testsByPath);
const integrationPaths = new Set(integrationManifest.map((test) => test.path));
const standaloneTests = tests.filter((test) => !integrationPaths.has(test.path));
const integrationTests = integrationManifest.map((entry) => testsByPath.get(entry.path));
const selected = mode === "--integration"
  ? integrationTests
  : mode === "--all"
    ? tests
    : standaloneTests;

if (!selected.length) {
  console.error(`No ${mode.slice(2)} tests were found.`);
  process.exit(2);
}

if (mode === "--standalone") {
  console.log(
    `Running ${standaloneTests.length} self-contained tests; `
    + `${integrationTests.length} manifest-declared host-integration tests are isolated.`,
  );
}

const selectedIntegrationEntries = mode === "--standalone" ? [] : integrationManifest;
const unavailableHostFiles = selectedIntegrationEntries.flatMap((test) => test.requiredHostFiles
  .filter((hostFile) => !isRegularFile(resolve(root, hostFile)))
  .map((hostFile) => `${test.path}: ${hostFile}`));

if (unavailableHostFiles.length) {
  console.error([
    "Host-integration requirements are not available in this checkout.",
    "Each path below is resolved from the chunk.js repository root:",
    ...unavailableHostFiles.map((entry) => `- ${entry}`),
    "Check out chunk.js as a direct child of the authorized NiceChunk host workspace,",
    "restore the listed host files, and rerun npm run test:integration.",
  ].join("\n"));
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...selected.map((test) => test.file)], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);

function discoverTests(directory) {
  const discovered = [];
  walk(directory);
  return discovered.sort((left, right) => left.path.localeCompare(right.path, "en"));

  function walk(currentDirectory) {
    const entries = readdirSync(currentDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const file = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        discovered.push({ file, path: repositoryPath(file) });
      }
    }
  }
}

function loadIntegrationManifest(testsByPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(hostIntegrationManifestFile, "utf8"));
  } catch (error) {
    failManifest([`cannot read valid JSON: ${error.message}`]);
  }

  const failures = [];
  if (!isRecord(manifest)) {
    failManifest(["top-level value must be an object"]);
  }

  const topLevelKeys = Object.keys(manifest).sort();
  if (topLevelKeys.join("\0") !== ["schemaVersion", "tests"].join("\0")) {
    failures.push("top-level keys must be exactly schemaVersion and tests");
  }
  if (manifest.schemaVersion !== 1) {
    failures.push("schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.tests)) {
    failures.push("tests must be an array");
    failManifest(failures);
  }

  const entries = [];
  const seenTestPaths = new Set();
  for (const [index, entry] of manifest.tests.entries()) {
    const label = `tests[${index}]`;
    if (!isRecord(entry)) {
      failures.push(`${label} must be an object`);
      continue;
    }

    const entryKeys = Object.keys(entry).sort();
    if (entryKeys.join("\0") !== ["path", "requiredHostFiles"].join("\0")) {
      failures.push(`${label} keys must be exactly path and requiredHostFiles`);
    }

    const pathIsValid = validateIntegrationTestPath(entry.path, label, failures);
    const hostFilesAreValid = validateRequiredHostFiles(entry.requiredHostFiles, label, failures);
    if (!pathIsValid || !hostFilesAreValid) continue;

    if (seenTestPaths.has(entry.path)) {
      failures.push(`${label}.path duplicates ${entry.path}`);
      continue;
    }
    seenTestPaths.add(entry.path);
    entries.push({
      path: entry.path,
      requiredHostFiles: [...entry.requiredHostFiles],
    });
  }

  const discoveredIntegrationPaths = [...testsByPath.values()]
    .filter((test) => isWithin(hostIntegrationDirectory, test.file))
    .map((test) => test.path);
  for (const path of discoveredIntegrationPaths) {
    if (!seenTestPaths.has(path)) {
      failures.push(`${path} is omitted from the host-integration manifest`);
    }
  }
  for (const path of seenTestPaths) {
    if (!testsByPath.has(path)) {
      failures.push(`${path} is listed but is not a discovered test file`);
    }
  }

  if (failures.length) failManifest(failures);
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function validateIntegrationTestPath(path, label, failures) {
  if (typeof path !== "string" || path.length === 0) {
    failures.push(`${label}.path must be a non-empty string`);
    return false;
  }
  if (
    isAbsolute(path)
    || path.includes("\\")
    || posix.normalize(path) !== path
    || !path.endsWith(".test.mjs")
  ) {
    failures.push(`${label}.path must be a normalized repository-relative .test.mjs path`);
    return false;
  }
  if (!isWithin(hostIntegrationDirectory, resolve(root, path))) {
    failures.push(`${label}.path must be inside tests/host-integration`);
    return false;
  }
  return true;
}

function validateRequiredHostFiles(hostFiles, label, failures) {
  if (!Array.isArray(hostFiles) || hostFiles.length === 0) {
    failures.push(`${label}.requiredHostFiles must be a non-empty array`);
    return false;
  }

  let valid = true;
  const seen = new Set();
  for (const [index, hostFile] of hostFiles.entries()) {
    const hostFileLabel = `${label}.requiredHostFiles[${index}]`;
    if (
      typeof hostFile !== "string"
      || hostFile.length === 0
      || isAbsolute(hostFile)
      || hostFile.includes("\\")
      || posix.normalize(hostFile) !== hostFile
      || !hostFile.startsWith("../")
      || isWithinOrEqual(root, resolve(root, hostFile))
    ) {
      failures.push(`${hostFileLabel} must be a normalized path outside the repository, relative to its root`);
      valid = false;
      continue;
    }
    if (seen.has(hostFile)) {
      failures.push(`${hostFileLabel} duplicates ${hostFile}`);
      valid = false;
      continue;
    }
    seen.add(hostFile);
  }
  return valid;
}

function failManifest(failures) {
  console.error([
    "Host-integration manifest validation failed:",
    ...failures.map((failure) => `- ${failure}`),
  ].join("\n"));
  process.exit(2);
}

function repositoryPath(file) {
  return relative(root, file).split(sep).join("/");
}

function isWithin(directory, file) {
  const pathFromDirectory = relative(directory, file);
  return pathFromDirectory !== ""
    && pathFromDirectory !== ".."
    && !pathFromDirectory.startsWith(`..${sep}`)
    && !isAbsolute(pathFromDirectory);
}

function isWithinOrEqual(directory, file) {
  return resolve(directory) === resolve(file) || isWithin(directory, file);
}

function isRegularFile(file) {
  if (!existsSync(file)) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
