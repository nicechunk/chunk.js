# Adoption and Release Plan

Chunk.js already contains opaque terrain, water, decoration, avatar, building, and auxiliary render passes. The remaining work is contract hardening and host adoption, not a future plan to add those basic passes.

## Phase 1: standalone contract

Release-blocking requirements:

- MIT license and explicit asset/mark boundaries;
- Node.js 20 or newer declared and exercised;
- scoped package exports, with `.`, `./src`, and `./engine` retained as convenience/legacy full barrels;
- generation version `5` and resource-rule version `1` accepted, all unknown versions rejected;
- high-level `destroy()` terminates its `ChunkManager` Workers and disposes renderer resources;
- every self-contained test included in `npm test`;
- host-coupled tests isolated under `npm run test:integration`;
- CI, contribution, support, and security workflows present;
- browser/HTTP requirements and compatibility evidence documented.

Do not set `private: false` or publish to npm as a side effect of completing this phase. Publication is a separate release decision.

## Phase 2: API and fallback parity

- Define and test public result schemas for Worker and main-thread paths.
- Add browser tests for module Worker startup, failure, retry, transfer ownership, and disposal.
- Add WebGL context-loss tests that cover terrain, visual, avatar, and auxiliary resources.
- Add generated or maintained type declarations before claiming typed package support.
- Classify stable, experimental, and internal exports.
- Remove direct root-barrel imports from examples where a narrow export exists.

Known implementation observations should remain visible until tests close them; documentation must not describe an aspirational fallback or context-recovery path as complete.

## Phase 3: host integration

The NiceChunk host should integrate in this order:

1. deterministic base reconstruction with explicit seed and versions;
2. confirmed chunk snapshots with revision/token/slot protection;
3. pending transaction previews, confirmation, and rollback;
4. validated `SurfaceDecorationTable` PDA injection;
5. NCBP blueprint verification and building placement/collision;
6. NCM4 appearance and NCF1 Forge runtime restoration;
7. renderer/input adoption with authority kept outside visual code.

For each step, run the isolated suite, the relevant host-integration suite, and a browser smoke test. A green standalone test does not authorize a production PDA or transaction change.

## Phase 4: browser and device evidence

- Establish a supported browser/device matrix from recorded smoke evidence.
- Capture repeatable performance baselines with environment metadata.
- Define route/device-specific frame-time, queue, and memory thresholds.
- Verify background/foreground, context loss, resize/DPR, long travel, and teardown/re-entry.
- Test Content Security Policy and deployed MIME/routing behavior.

Do not claim Safari, Firefox, embedded webview, or mobile support from a Chrome-only run.

## Phase 5: optional package publication

Publication requires an explicit maintainer decision and release checklist:

- remove `private: true` intentionally;
- confirm package `files`, exports, types, provenance, and tarball contents;
- run license/NOTICE and external-asset review;
- create a versioned changelog and tag;
- verify install from the packed artifact in a clean project;
- publish only from a protected, reviewed workflow.

Until then, consumers use a clone, workspace, or reviewed file dependency.

## Shared-source synchronization

Chunk.js runtime files also have a website-source counterpart, while this standalone Git repository owns its MIT and GitHub governance metadata. Synchronization must use an explicit manifest/allowlist and a dry run. Never overwrite README, license, package metadata, docs, or `.github/` with an unreviewed whole-tree copy.

Files shared with Apache-2.0 NiceChunk repositories require separate authorization and per-file license review. The existence of identical code does not establish permission or automatic dual licensing.

## Rollback criteria

Pause or roll back an adoption step when it causes:

- world/resource output disagreement for the same supported inputs;
- acceptance of an unknown rule version;
- stale snapshots overwriting newer confirmed deltas;
- Worker/main-thread schema divergence;
- persistent Workers or GPU resources after teardown;
- context restoration with invalid resource handles;
- production use of bundled surface-rule fixtures;
- browser regressions outside the recorded support evidence;
- unclear asset or cross-repository licensing.

A visual difference alone may be a renderer bug; an authoritative block/resource difference is a protocol incident and must be treated separately.
