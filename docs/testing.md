# Testing

Chunk.js separates repository tests from host integration and browser evidence.

## Supported Node version

Use Node.js 20 or newer. Continuous integration exercises Node.js 20, 22, and 24. Passing on another local Node version alone is not a compatibility claim.

The current package has no dependencies. CI intentionally performs no install step and uses npm only to invoke scripts.

## Self-contained gate

```bash
npm test
npm run check
```

`npm test` recursively discovers every self-contained `*.test.mjs` file under `tests/` rather than maintaining a hand-written standalone subset. Tests below `tests/host-integration/` are always excluded from this command. `npm run check` adds repository policy and static module checks before invoking the self-contained tests.

A self-contained test may use repository fixtures but must not import files above the repository root or depend on a running NiceChunk host.

## Host integration tests

```bash
npm run test:integration
```

Host integration tests intentionally use resources from the wider NiceChunk workspace. Recorded relative to the Chunk.js repository root, current examples include:

- smelting rules from `../src/data/smeltingRules.js`;
- resource-drop rules from `../src/data/resourceDropRules.js`;
- the Forge chain adapter from `../forging/chain-adapter.js`;
- host JSON such as `../public/rules/smelting-rules.json`.

The integration command should fail clearly when those fixtures are unavailable. It must not silently skip missing authority data and report a false green result. These tests are not expected to pass in an isolated clone unless the required host workspace is provided.

Every host integration test belongs below `tests/host-integration/` and must have an entry in `tests/host-integration/manifest.json`. The manifest records the test path and each required host file as a path relative to the Chunk.js repository root. The runner rejects an unlisted test, a manifest entry that does not resolve to a discovered test, duplicate entries, and malformed or repository-local host-file declarations before it runs anything. Missing host files are reported per test and make `npm run test:integration` exit unsuccessfully.

## Browser smoke tests

Node tests do not create a real WebGL2 context or prove module Worker delivery. Follow [Browser support](browser-support.md) for the manual smoke procedure. When browser automation is added, keep its result separate from the Node unit gate and record the browser version.

Important browser scenarios include:

- native ESM and MIME delivery;
- module Worker startup, transfer, retry, and disposal;
- WebGL2 initialization and context restoration;
- avatar-buffer restoration after context loss;
- high-level engine teardown without retained Workers;
- building Worker and main-thread fallback returning the same schema.

## Version contract tests

Generation version `5` and resource-rule version `1` are the only supported release versions. Tests must cover both accepted values and fail-closed behavior for older, newer, negative, missing, or malformed versions at every public proof/reconstruction boundary.

Golden world tests should include seed bytes, generation version, resource-rule version, integer coordinates, block/resource output, and an explicit fixture revision. Signed-boundary coverage must exercise derived-coordinate saturation, not merely validate that the public input fits i32/i16. The v5 endpoint fixture records the Rust source revision and content hash, checks complete columns plus coal/tree/noise edge cases, and retains separate interior signatures. Changing a golden is a protocol change, not a cosmetic test update.

## Benchmarks

Run the building mesher benchmark from the repository root:

```bash
node --expose-gc benchmarks/building-mesher.mjs 5
```

The numeric argument is the iteration count. Record the exact commit, Node version, CPU, memory, operating system, input, warm-up policy, and command. Do not turn a one-machine observation into a universal budget.

## Adding a test

- Place self-contained Node tests anywhere under `tests/`, except `tests/host-integration/`, with the `.test.mjs` suffix.
- Keep deterministic assertions independent of wall-clock timing where possible.
- Assert both Worker and main-thread fallback contracts when an API supports both.
- Use explicit typed-array and ownership assertions for transferable data.
- Put cross-repository tests below `tests/host-integration/` and declare the test plus every external fixture in `tests/host-integration/manifest.json`.
- Add a browser regression when behavior depends on WebGL, DOM, module Worker, CSP, or context lifecycle.

## Interpreting results

A green `npm test` means the self-contained Node suite passed. It does not prove:

- browser or GPU compatibility;
- production RPC/PDA integration;
- host asset availability;
- performance on a target device;
- correctness of an unsupported generation or resource-rule version;
- license compatibility of external assets.
