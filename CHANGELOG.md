# Changelog

All notable changes to Chunk.js will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use [Semantic Versioning](https://semver.org/spec/v2.0.0.html) when it begins publishing releases. The current package is private and is not published to npm; a changelog entry does not by itself identify a supported release.

## [Unreleased]

### Added

- MIT licensing and a detailed license-status boundary for repository code, the embedded default avatar, NiceChunk marks, and external assets.
- Contribution, security, support, and community-conduct policies.
- An honest security-contact request route for periods when GitHub private vulnerability reporting is disabled.
- Explicit CC BY 4.0 attribution for the adapted Contributor Covenant document, kept separate from the code's MIT grant.
- Pull request, bug report, and feature request templates.
- A standalone CI matrix for supported Node.js 20, 22, and 24 releases.
- Narrow package exports for engine creation, the game-facing graph, world, renderer, capabilities, math, and the NCM codecs.
- Governance documents in file-dependency tarballs, with installed-package Markdown link verification.
- Automatic standalone/integration test discovery and focused regression coverage for versions, engine teardown, renderer context invalidation, building result parity, and codec input limits.
- Third-party setup, architecture, API, browser, testing, versioning, Worker, renderer lifecycle, trust-boundary, performance, migration, and troubleshooting documentation.

### Changed

- Documented Node.js 20 as the minimum development runtime.
- Separated the self-contained `npm test` contract from host-dependent `npm run test:integration` checks.
- Replaced the package check's undeclared system `tar` dependency with an actual local npm installation of the generated artifact.
- Documented that shared-file synchronization with Apache-licensed repositories requires explicit authorization and license review.
- Reject unsupported world-generation and resource-rule versions instead of accepting version labels that do not select an implemented algorithm.
- Made high-level engine destruction terminate owned chunk Workers before releasing renderer resources.
- Normalized building Worker and main-thread fallback results through one mutable `{ building, placement, chunks }` summary schema. Parser-only voxel/blueprint fields, materialized placement voxels, and arbitrary foundation metadata are no longer exposed; consumers that need them must parse or retain host state separately.
- Limited caller-supplied building, foundation, and placement labels to 1,024 characters and snapshot only the fixed construction request fields before Worker dispatch.
- Added per-chunk `voxelCount` and `visualBlockCount` to the building result schema and bound their local and aggregate values to mesh, collision, building, and reported final-material classifications. This is a pre-1.0 Worker protocol migration; cached senders and receivers must be updated together.
- Invalidated avatar and other context-owned buffer caches after WebGL context restoration and preserved the configured dynamic-shadow caster limit.
- Tightened NCM3/NCM4 payload size and canonical Base64URL validation at decode boundaries.
- Rejected overlong or overflowing NCM3 varints and enforced NCM3, NCM4 CRC, NCBP, and NCF1 input limits before Base64 decoding or BufferSource copying.
- Added finite world/chunk streaming limits and exact signed coordinate/block-ID bounds so main-thread and Worker delta semantics cannot diverge through typed-array truncation.
- Matched Rust generation-v5 saturating arithmetic across signed-i32 terrain/river warps, noise neighbors, coal seams, tree candidates, and leaf hashes; Rust-emitted endpoint columns now pass while established interior signatures remain unchanged.
- Detached config, manager, chunk-state, and Worker seed bytes from public typed-array mutation so cached and uncached salts cannot split one world identity.
- Bounded delta batches, touched chunks, per-chunk resident chain/pending state, and Worker payloads; configured-world Y and all resource ceilings now fail before chunk loading or unbounded packing.
- Documented the intentional distinction between coercing configuration objects and strict reconstruction/proof inputs, including the mandatory `getResourceAt()` generation version.
- Separated Forge v1 gameplay `densityScore` from physical `densityKgM3`; workbench mass, physical advisory, heat, and attribute inheritance now use bounded physical density, `massWeight` is an exact microgram count rather than a score product, and missing metadata uses an explicitly marked archetype fallback.
- Kept Forge texture creation on its deterministic material-manager default when callers omit a seed, while preserving strict rejection of an explicitly empty seed.
- Corrected NCF1 `mass5g` derivation to encode units of 5 grams. The v14 layout is unchanged, but affected workbench inputs produce corrected mass bits and therefore different canonical codes and design hashes.
- Made NCF1 plain-array conversion copy only validated indexed elements, preventing a custom or infinite array iterator from bypassing the pre-allocation byte limit.
- Snapshotted NCF1 wrapper inputs once during validation so stateful getters cannot split the decoded design from the returned bytes and code.
- Unified custom-world vertical reconstruction across point, base, materialized, and compact-profile paths; terrain and water now respect `maxBuildY`, including supported one-layer worlds.
- Preserved `maxBuildY` in compact profiles and retained partially overlapping endpoint chunks for non-divisor development chunk sizes by evaluating exact chunk/local affine coordinates before one final i32 saturation; canonical size `16` remains identical to the Rust verifier.
- Unified main-thread and Worker meshing callbacks with that saturated endpoint mapping, deduplicated endpoint tree/canopy aliases onto the in-domain affine cell, and documented why GPU/frustum origins remain exact affine values plus the remaining non-canonical base-fringe visualization limitation.
- Made chain, pending, and full-snapshot delta batches atomic; foreign-chunk snapshots and coerced or unsafe revision/token/slot metadata now fail closed without changing maps, caches, revisions, or dirty state.
- Kept foreign-only incremental chain and pending batches as no-op operations so they cannot dirty an unrelated chunk.
- Recovered queued and in-flight chunk work after Worker construction, runtime, message, or serialization failure without disposing the manager.
- Closed chunk Worker response ownership across task ID, sender, coordinates, phase, type, mode, and echoed versions; faulty/error senders are quarantined without stranding chunks or consuming another Worker's task, while known late canceled responses are harmless.
- Made building Worker responses require the current Worker and exact active request ID, so malformed, unknown, and stale responses cannot leave a request pending or disrupt a replacement Worker.
- Bound successful building Worker results to their dispatched request with a decode-only NCM3 command-envelope pass over payload, name, size, command count, exact content bounds, referenced materials, and voxel upper bounds. This is an internal-consistency boundary rather than a second semantic voxelization of overlapping commands.
- Validate bounded building chunk, collision, vertex, and index schemas in place before exposing transferred or fallback-owned buffers, while keeping surrounding summaries equally mutable in both modes.
- Corrected multi-chunk building result validation so opaque, visual, and collision totals accumulate against the building-wide voxel count instead of incorrectly comparing later chunks with earlier cumulative values.
- Decomposed safe-integer building coordinates into chunk/local pairs with exact BigInt Euclidean arithmetic, preventing non-power-of-two chunk sizes from losing endpoint collision bits through floating-point origin reconstruction.
- Made shared shader-program creation release every intermediate shader/program object on compilation or link failure.
- Made WebGL2 renderer initialization transactional across programs, textures, auxiliary passes, canvas sizing, and context listeners, leaving a clean state that can be retried after any initialization-stage failure.
- Made Forge workbench initialization transactional across lifecycle listeners, controls, resize observation, mesh uploads, shader programs, and material textures; factory failures now dispose the otherwise unreachable renderer while direct instances remain retryable.
- Made Forge material-texture creation and replacement transactional so a failed upload releases its partial texture and preserves the last working texture array.
- Made avatar and smelting preview factories attach owned canvases only after successful initialization, release partial GPU allocations on late failures, and preserve existing canvases they do not own.
- Updated browser demos and examples to use narrow source imports and to report that non-tree decorations remain disabled until rules are supplied.
- Made high-level engine start/stop/destroy transitions idempotent, kept destroyed status terminal across late UI calls, rejected malformed budgets and callbacks before allocation, removed an undocumented cleanup helper from the narrow engine export, and added teardown to the browser examples.
- Corrected public NCM material presentation metadata so fluid and transparent shader classes, including ice, glass, and salt, expose their actual alpha instead of appearing opaque.
