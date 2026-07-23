import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const binaryExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".ncm",
  ".png",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
]);
const forbiddenDirectory = /(^|\/)(?:\.auth|\.gh-config|\.ssh)(\/|$)/i;
const forbiddenFile = /(^|\/)(?:\.env(?:\..*)?|hosts\.ya?ml|id_ed25519|id_rsa|rpc_key)$/i;
const forbiddenExtension = /\.(?:key|pem)$/i;
const keypairFile = /(^|\/)[^/]*keypair[^/]*\.json$/i;
const localeJson = /(^|\/)locales\/[^/]+\.json$/i;
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/,
];

const files = await collectFiles(root);
const failures = [];

for (const file of files) {
  const path = relative(root, file).replaceAll("\\", "/");
  if (
    forbiddenDirectory.test(path)
    || forbiddenFile.test(path)
    || forbiddenExtension.test(path)
    || keypairFile.test(path)
  ) {
    failures.push(`${path}: forbidden credential path`);
    continue;
  }
  if (binaryExtensions.has(extname(path).toLowerCase())) continue;
  const source = await readFile(file, "utf8");
  if (/\p{Script=Han}/u.test(source) && !localeJson.test(path)) {
    failures.push(`${path}: Han text is only allowed in locale JSON files`);
  }
  if (secretPatterns.some((pattern) => pattern.test(source))) {
    failures.push(`${path}: probable secret content`);
  }
}

await validateRepositoryMetadata(files, failures);

if (failures.length) {
  console.error(`Repository policy check failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`Repository policy check passed for ${files.length} files.`);

async function validateRepositoryMetadata(repositoryFiles, findings) {
  const relativeFiles = new Set(repositoryFiles.map((file) => relative(root, file).replaceAll("\\", "/")));
  const requiredFiles = [
    "LICENSE",
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "docs/license-status.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/security_contact.yml",
    ".github/workflows/ci.yml",
  ];
  for (const file of requiredFiles) {
    if (!relativeFiles.has(file)) findings.push(`${file}: required repository file is missing`);
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packageJson.license !== "MIT") findings.push("package.json: license must be MIT");
  if (packageJson.repository?.url !== "git+https://github.com/nicechunk/chunk.js.git") {
    findings.push("package.json: canonical GitHub repository URL is missing");
  }
  if (packageJson.scripts?.test !== "node tools/run-tests.mjs") {
    findings.push("package.json: npm test must use the complete test discovery runner");
  }

  if (relativeFiles.has("LICENSE")) {
    const license = await readFile(join(root, "LICENSE"), "utf8");
    if (!license.startsWith("MIT License\n")) findings.push("LICENSE: standard MIT heading is missing");
    if (!license.includes("Copyright (c) 2026 NiceChunk")) findings.push("LICENSE: project copyright line is missing");
    if (!license.includes("Permission is hereby granted, free of charge")) findings.push("LICENSE: standard MIT grant is missing");
  }

  if (relativeFiles.has("README.md")) {
    const readme = await readFile(join(root, "README.md"), "utf8");
    if (!/\[MIT(?: License)?\]\((?:\.\/)?LICENSE\)/.test(readme)) {
      findings.push("README.md: MIT license link is missing");
    }
  }

  if (relativeFiles.has("CODE_OF_CONDUCT.md")) {
    const conduct = await readFile(join(root, "CODE_OF_CONDUCT.md"), "utf8");
    if (!conduct.includes("https://creativecommons.org/licenses/by/4.0/")) {
      findings.push("CODE_OF_CONDUCT.md: Contributor Covenant CC BY 4.0 notice is missing");
    }
  }

  if (relativeFiles.has(".github/workflows/ci.yml")) {
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
    validateCiActions(workflow, findings);
  }
}

function validateCiActions(workflow, findings) {
  const expectedPins = new Map([
    ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
    ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ]);
  const references = [...workflow.matchAll(/^\s*uses:\s*([^\s@]+)@([^\s#]+)/gm)]
    .map((match) => ({ action: match[1], reference: match[2] }));

  for (const { action, reference } of references) {
    if (!action.startsWith("./") && !/^[0-9a-f]{40}$/.test(reference)) {
      findings.push(`.github/workflows/ci.yml: ${action} must use a full commit SHA`);
    }
  }

  for (const [action, expectedReference] of expectedPins) {
    const matches = references.filter((entry) => entry.action === action);
    if (matches.length === 0) {
      findings.push(`.github/workflows/ci.yml: required ${action} step is missing`);
    } else if (matches.some((entry) => entry.reference !== expectedReference)) {
      findings.push(`.github/workflows/ci.yml: ${action} must use the reviewed commit SHA`);
    }
  }

  if (!/^\s*uses:\s*actions\/checkout@[0-9a-f]{40}(?:\s+#.*)?\n\s*with:\s*\n\s+persist-credentials:\s*false\s*$/m.test(workflow)) {
    findings.push(".github/workflows/ci.yml: checkout must set persist-credentials: false");
  }
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
