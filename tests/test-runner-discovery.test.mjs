import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("the standalone runner recursively discovers tests without executing host integrations", async (context) => {
  const fixture = await createRunnerFixture(context, {
    integrationTests: ["tests/host-integration/host.test.mjs"],
    standaloneTests: ["tests/nested/deeper/standalone.test.mjs"],
  });

  const result = runFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Running 1 self-contained tests; 1 manifest-declared host-integration tests are isolated\./);
  assert.doesNotMatch(result.stdout + result.stderr, /host integration was executed/);
});

test("the runner rejects a host integration omitted from the manifest", async (context) => {
  const fixture = await createRunnerFixture(context, {
    integrationTests: ["tests/host-integration/omitted.test.mjs"],
    manifestTests: [],
  });

  const result = runFixture(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /tests\/host-integration\/omitted\.test\.mjs is omitted from the host-integration manifest/);
});

test("the runner rejects a manifest entry that points to no discovered test", async (context) => {
  const fixture = await createRunnerFixture(context, {
    manifestTests: ["tests/host-integration/missing.test.mjs"],
  });

  const result = runFixture(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /tests\/host-integration\/missing\.test\.mjs is listed but is not a discovered test file/);
});

test("the integration runner reports every missing host file before executing tests", async (context) => {
  const testPath = "tests/host-integration/host.test.mjs";
  const fixture = await createRunnerFixture(context, {
    integrationTests: [testPath],
    requiredHostFiles: {
      [testPath]: ["../first-host-file.js", "../second-host-file.json"],
    },
  });

  const result = runFixture(fixture, "--integration");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Host-integration requirements are not available in this checkout\./);
  assert.match(result.stderr, /tests\/host-integration\/host\.test\.mjs: \.\.\/first-host-file\.js/);
  assert.match(result.stderr, /tests\/host-integration\/host\.test\.mjs: \.\.\/second-host-file\.json/);
  assert.doesNotMatch(result.stdout + result.stderr, /host integration was executed/);
});

async function createRunnerFixture(context, {
  integrationTests = [],
  manifestTests = integrationTests,
  requiredHostFiles = {},
  standaloneTests = [],
}) {
  const root = await mkdtemp(join(tmpdir(), "chunk-js-test-runner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tools"), { recursive: true });
  await mkdir(join(root, "tests", "host-integration"), { recursive: true });
  await copyFile(new URL("../tools/run-tests.mjs", import.meta.url), join(root, "tools", "run-tests.mjs"));

  for (const path of standaloneTests) {
    await writeTest(root, path, 'console.log("nested standalone reached");\n');
  }
  for (const path of integrationTests) {
    await writeTest(root, path, 'throw new Error("host integration was executed");\n');
  }

  const manifest = {
    schemaVersion: 1,
    tests: manifestTests.map((path) => ({
      path,
      requiredHostFiles: requiredHostFiles[path] ?? ["../host-fixture.js"],
    })),
  };
  await writeFile(
    join(root, "tests", "host-integration", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}

async function writeTest(root, path, source) {
  const file = join(root, ...path.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);
}

function runFixture(root, mode) {
  const argumentsList = [join(root, "tools", "run-tests.mjs")];
  if (mode) argumentsList.push(mode);
  return spawnSync(process.execPath, argumentsList, {
    cwd: root,
    encoding: "utf8",
  });
}
