# API Guide

Chunk.js is pre-1.0. This guide describes supported boundaries and lifecycle expectations; it is not a promise that all currently exported symbols are stable.

## Import policy

The `.`, `./src`, and `./engine` package exports are convenience and legacy full barrels. They expose a broad graph spanning world, chunk, renderer, NCM, construction, Forge, input, physics, and debug helpers. In native browser ESM, every re-export is fetched and evaluated even when an import names only one symbol.

The package provides these narrow exports. Prefer the narrowest one that contains the required API:

| Area | Package surface | Responsibility |
| --- | --- | --- |
| Engine creation | `@nicechunk/chunk-js/engine/create` | High-level assembly and lifecycle |
| Game-facing graph | `@nicechunk/chunk-js/play` | Curated browser/game integration surface |
| World | `@nicechunk/chunk-js/world` | Deterministic generation and registries |
| Renderer | `@nicechunk/chunk-js/renderer` | WebGL2 renderer and support detection |
| Capabilities | `@nicechunk/chunk-js/capabilities` | Environment/capability detection |
| Math | `@nicechunk/chunk-js/math` | Shared math helpers |
| NCM blueprint | `@nicechunk/chunk-js/ncm/blueprint` | NCM2/NCM3 blueprint codec |
| NCM character | `@nicechunk/chunk-js/ncm/character` | NCM4 character codec |

Exact subpaths are defined only by `package.json`. A filesystem path that is absent from the package `exports` map is internal even if it can be reached in a clone.

For direct browser development in the repository, `play.js` is the curated game-facing module graph. Specific source-file imports are also appropriate for demos and diagnostics. Avoid `src/index.js` when graph size matters.

## High-level engine

```js
import { createChunkEngine } from "@nicechunk/chunk-js/engine/create";

const engine = await createChunkEngine({
  canvas,
  viewDistance: 3,
  meshBudgetMs: 6,
  onStats: (sample) => updateDiagnostics(sample),
  onStatus: (status) => updateStatus(status),
});

if (engine.supported) engine.start();

// Complete teardown boundary.
engine.destroy();
```

`createChunkEngine()` requires an options object and a canvas. `meshBudgetMs` must be a finite non-negative number, and non-null `onStats`/`onStatus` values must be functions; malformed options reject before world, Worker, or renderer allocation. Its unsupported result has no active renderer or Workers and exposes no-op lifecycle methods so callers can use one cleanup path.

Lifecycle contract:

- `start()` begins the animation loop and is idempotent while already running.
- `stop()` stops the animation loop but keeps world and GPU resources allocated.
- `setPaused(value)` controls automatic camera motion in the simple engine; it is not teardown.
- `resetCamera()` resets the demonstration camera.
- `destroy()` stops animation, terminates the owned `ChunkManager` Workers, disposes renderer resources, and must be safe to call during view teardown.

This complete Worker cleanup behavior is part of the current release contract. Consumers targeting older commits should inspect the implementation before relying on it.

## World generation and resources

Key functions include:

- `createWorldGeneratorConfig(options)`
- `generateBaseChunk(seed, chunkX, chunkZ, generationVersion, options)`
- `generateBaseChunkProfile(...)`
- `getBlockAt(seed, worldX, worldY, worldZ, generationVersion, options)`
- `getResourceAt(seed, worldX, worldY, worldZ, resourceRuleVersion, options)`

Coordinates used for reconstruction or proof must be integers. Rendering floats, mesh buffers, local pending deltas, camera-relative coordinates, and decoration geometry are not proof inputs.

World configuration is deliberately bounded before allocation or iteration. The current limits are chunk size `1..64`, height `1..4096`, at most `4,194,304` voxels in one materialized chunk, and signed 16-bit vertical bounds. `maxBuildY` must remain inside the configured vertical span. `WORLD_GENERATOR_LIMITS` exposes these release values; invalid, non-finite, fractional, or oversized dimensions throw `RangeError` instead of being truncated or replaced with defaults.

Configuration objects and authority-sensitive reconstruction calls intentionally have different coercion contracts. `createWorldGeneratorConfig()`, `ChunkManager`, and `ChunkState` normalize their supported integer settings and version fields with `Number()`, so a controlled numeric string such as `"5"` is accepted there. Direct reconstruction and proof functions require actual integer coordinates and explicit numeric versions; `"5"`, `"0"`, omitted versions, fractions, and non-finite values fail closed. Do not use the convenience configuration coercion as a parser for persisted proof or chain data.

Generated blocks occupy `minY..maxBuildY` inclusively. Terrain and water requests that exceed that effective domain are clipped during generation: terrain retains one block of headroom when the span permits it, water never rises above `maxBuildY`, and a one-layer world resolves its sole block as bedrock. The direct, materialized, and `baseProfile`/resolver APIs share this boundary behavior, and generated profiles include `maxBuildY` so profile-only `ChunkState` construction cannot widen the domain.

`worldSeed` on a generator config, `ChunkManager`, or `ChunkState` is a detached copy of privately owned normalized bytes. Mutating a returned `Uint8Array` does not reconfigure that object, invalidate its canonical `worldSeedHex`, or alter existing synchronous/Worker generation. Construct a new config or manager to select a different seed.

`ChunkManager({ maxBuildY })` applies the same normalized ceiling to synchronous chunks, delta admission, point lookup, and the existing Worker options payload; it does not silently replace a custom ceiling with the top of the allocation span.

Release version contract:

- generation version: `5` only;
- resource-rule version: `1` only;
- any unknown or malformed version: fail closed.

`getResourceAt()` always requires a numeric resource-rule version in its fifth argument and a numeric generation version in `options.generationVersion`. The generation version remains mandatory even when `options.blockId` supplies the block directly, because the returned proof record includes both validated version domains.

Do not interpret a returned version field as validation unless the called public boundary documents and tests fail-closed behavior. See [World generation and versioning](world-generation-and-versioning.md).

Use a 32-byte seed or a 64-character hexadecimal encoding at chain boundaries. Arbitrary text seed normalization exists for development convenience but should not define a new external proof format.

## Chunk state and manager

`ChunkState` owns one chunk's deterministic base resolver/profile, confirmed chain deltas, pending local deltas, snapshot authority metadata, and mesh revisions.

Final state is:

```text
pending delta > chain delta > deterministic base
```

`ChunkManager` owns loaded chunks, build queues, module Workers, visibility, neighbor-delta transfer, retry state, and surface-decoration rules. Important integration operations include:

- updating player position and load direction;
- applying or replacing confirmed chain deltas;
- applying, confirming, or rolling back pending deltas;
- rebuilding dirty chunks within a time budget;
- querying integer blocks and visible chunks;
- injecting validated surface-decoration rules;
- calling `dispose()` to terminate Workers and clear queued/in-flight work.

Streaming controls are also bounded: view distance `1..32`, preload margin `0..8`, Worker count `1..32` when Workers are enabled, queued builds `1..8192`, and visibility linger `0..10000` frames. The limits are available as `CHUNK_MANAGER_LIMITS` from the full source API. Assigning a non-finite or out-of-range value fails immediately; it must never enter a range loop or Worker-allocation path.

Chunk deltas use the same exact representation on the main thread and in the Worker transfer. `worldX`/`worldZ` are signed 32-bit integers, `worldY` is a signed 16-bit integer, and `blockId` is an unsigned 16-bit integer. Numeric strings, fractions, missing fields, and out-of-range values are rejected rather than truncated. These bounds are exposed as `DELTA_PROTOCOL_LIMITS` from the full source API.

Delta resource ceilings are separate from the coordinate protocol. One call accepts at most `262144` entries and may touch at most `2048` chunks. A chunk retains at most `262144` chain-plus-pending Map entries, counting an overlapping chain and pending value as two resident entries. A Worker payload is likewise capped at `262144` entries. `DELTA_RESOURCE_LIMITS` exposes these implementation budgets; they may change independently of generation or proof versions.

Manager batches are fully normalized, checked against the configured `minY..maxBuildY` range, grouped, and capacity-checked before they can load or mutate the first chunk. Delta batches are transactional at the `ChunkState` boundary. Every entry is normalized before any chain or pending Map, merged-map cache, revision, or mesh-dirty state changes; one malformed or resource-exhausting entry rejects the whole batch. A complete chain snapshot must contain only entries owned by its target chunk. A foreign-chunk entry is an error, not an empty or partial replacement.

Snapshot revision, token, and slot values are concurrency controls. `expectedChainRevision: null` means that no revision precondition was supplied. Every supplied revision and every token or slot must be a non-negative JavaScript safe integer; strings, fractions, non-finite numbers, and unsafe integers are rejected without coercion. `acknowledgeChainSnapshot()` applies the same token/slot contract. A host must not replace newer state with a stale RPC snapshot.

## Workers and ownership

Chunk and building Workers use module URLs resolved from `import.meta.url`. Mesh and packed-delta buffers may be transferred rather than cloned. After a sender transfers an `ArrayBuffer`, it must treat that buffer as detached and relinquish ownership.

Worker and main-thread fallback paths must resolve the same documented result schema. Do not branch application behavior on Worker availability. See [Worker protocol](worker-protocol.md).

## Renderer

`WebGL2VoxelRenderer` owns WebGL programs, textures, terrain and visual buffers, region batches, avatar buffers, sky/cloud/sun resources, shadows, overlays, and particles.

Typical lower-level order:

1. construct with a canvas and options;
2. call `init()`;
3. prepare visible chunks for render;
4. call `render(camera, chunks, avatars)` each frame;
5. respond to status and context lifecycle;
6. call `dispose()` exactly once during teardown.

The default renderer groups chunks into 4 by 4 regions when region batching is enabled. A visible chunk is therefore not necessarily one draw call.

Renderer output is non-authoritative. Colors, AO, fog, shadows, preview meshes, animations, and camera-relative floats must never determine chain actions. See [Renderer lifecycle](renderer-lifecycle.md).

## NCM and construction

- NCM3 describes declarative voxel blueprints.
- NCM4 describes a bounded, CRC32C-protected animated character.
- NCM2 remains a compatibility format.
- Construction helpers parse NCM3, apply integer translation and quarter-turn rotation, partition meshes by chunk, and expose collision queries.

Treat decoded data as untrusted input until the relevant envelope, hash, canonical encoding, bounds, and authority have been checked. Raw NCM text accepted from an account is not automatically a verified PDA blueprint.

`decodeBlueprintAccount()` accepts only `ArrayBuffer` or `ArrayBufferView` input and checks its byte length before creating a byte view. NCM3 uses canonical unsigned 32-bit varints and rejects overlong encodings. `ncm4Crc32c()` likewise accepts bounded BufferSource input only; it is not a general unbounded checksum utility.

`analyzeNcm3Envelope(code)` decodes and validates NCM3 without materializing voxels. It returns the canonical code, payload bytes, decoded name/size and command count, sorted referenced materials, the expanded command-write upper bound, a request-safe maximum voxel count, and exact occupied content bounds implied by the commands. `maxVoxelCount` is an upper bound, not the final unique voxel count: overlapping writes are deliberately not replayed by this helper.

### Building mesh Worker client

`createBuildingMeshWorkerClient()` is exported by `@nicechunk/chunk-js/play` and the legacy full barrels. It runs NCM3 parsing, placement, and meshing in a module Worker when available and preserves the same validated result contract in its main-thread fallback.

```js
import { createBuildingMeshWorkerClient } from "@nicechunk/chunk-js/play";

const client = createBuildingMeshWorkerClient();
const controller = new AbortController();

try {
  const result = await client.build({
    code: canonicalNcm3Code,
    buildingId: "house-42",
    placementId: "plot-7:house-42",
    foundation: {
      id: "plot-7",
      minX: 160,
      minZ: -48,
      surfaceY: 72,
      width: 12,
      depth: 10,
    },
    quarterTurns: 1,
    offsetX: 0,
    offsetZ: 0,
    chunkSize: 16,
    revision: 4,
  }, {
    priority: 10,
    scope: "visible-region",
    signal: controller.signal,
  });

  consumeBuildingChunks(result.chunks);
} finally {
  client.dispose();
}
```

Constructor options:

| Option | Contract |
| --- | --- |
| `useWorker` | Defaults to `true`. `false` selects the validated main-thread path. |
| `workerFactory` | Optional factory for a compatible module Worker, primarily for controlled hosts and tests. |

`build(input, scheduling)` snapshots its input when the job becomes active. Mutating the caller's object after dispatch cannot change request/result binding. Only one job is active; queued jobs run by descending finite `priority`, then insertion order. `scope` is an application cancellation key, and `signal` may be an `AbortSignal`.

The construction input has this public shape:

| Field | Contract |
| --- | --- |
| `code` | Required bounded NCM3 text. Surrounding whitespace is trimmed; decode, command, operation, and voxel limits still apply. |
| `buildingId`, `placementId` | Optional labels. Each caller-supplied label is limited to 1,024 characters. Deterministic IDs are derived when omitted. |
| `foundation` | Required placement object. `id` is limited to 1,024 characters; `minX`, `minZ`, `surfaceY`, `width`, and `depth` normalize to safe integers, with positive dimensions. Coordinate aliases accepted by the lower-level placement API are normalized before Worker dispatch. |
| `quarterTurns` | Integer quarter turns, or a multiple of 90 degrees outside the `-3..3` shorthand range; normalized modulo four. |
| `offsetX`, `offsetZ` | Safe-integer placement offsets; default to zero. |
| `allowFoundationOverflow` | Overflow is allowed only when exactly `true`; otherwise a non-fitting placement rejects. |
| `chunkSize` | Positive integer no greater than 16; defaults to 16. |
| `revision` | Mesh version normalized to a positive safe integer; defaults to 1. |

No additional foundation or host metadata crosses this boundary. If the application needs ownership, account, proof, or UI metadata after the build, retain it outside the request rather than expecting it in the result.

Horizontal safe-integer coordinates are decomposed into chunk and local coordinates with exact Euclidean BigInt arithmetic. Mesh construction and collision queries use the same mapping, including negative coordinates and non-power-of-two chunk sizes, so floating-point reconstruction of `chunk * chunkSize` cannot move an endpoint voxel into an invalid local cell.

The resolved value is exactly `{ building, placement, chunks }`. Its stable summary fields are:

```text
building = {
  id, name, format, formatVersion, canonicalCode, canonical,
  payloadBytes, codeId, size, contentBounds, voxelCount,
  commandCount, materials, scale
}

placement = {
  id,
  foundation: { id, minX, minZ, surfaceY, width, depth, maxX, maxZ },
  fitsFoundation, offsetX, offsetZ, quarterTurns,
  footprint, origin, bounds, voxelCount, scale
}

chunk = {
  id, buildingId, chunkX, chunkZ, chunkSize, minY, height,
  voxelCount, visualBlockCount,
  collisionMask, collisionBlockCount,
  mesh, visualMesh,
  meshVersion, visualMeshVersion, version,
  gpuUploaded, visualGpuUploaded, building,
  regionBatchEligible, frustumCullEligible, frustumBounds
}

mesh = {
  vertices, indices, vertexCount, indexCount, triangleCount,
  quadCount, blockCount, vertexStrideBytes,
  chunkX, chunkZ, chunkSize, minY, height, building, visual
}
```

`size`, `footprint`, `origin`, `bounds`, and `frustumBounds` are plain numeric records. `collisionMask` is `Uint32Array`; mesh `vertices` is `Uint8Array`; mesh `indices` is `Uint16Array` or `Uint32Array` according to vertex count. `visualMesh` may be `null`. A fully occluded visual voxel still contributes to `visualBlockCount`, so a nonzero visual count does not by itself require a visual mesh. The claimed final `building.materials` set is also bound to global rendering and collision classifications: opaque materials are opaque and colliding, transparent materials are visual and colliding, and fluid/cutout materials are visual and non-colliding. Mixed reported classes must each account for at least one voxel.

The summary omits parser-heavy or host-owned state: there is no `sourceCode`, decoded blueprint object, local voxel `Map`, materialized `worldVoxels`, compact placement record, or arbitrary foundation metadata. This is intentional and applies in both execution modes.

Result objects and their nested summary records are mutable and consumer-owned. Worker buffers arrive by transfer; fallback summaries reuse the mesher's buffers. Validation walks those owned views in place and does not copy them. Consumers may retain or mutate the resolved data, but must not expect a later revalidation to repair a modified mesh.

Lifecycle methods:

| Method | Behavior |
| --- | --- |
| `build(input, scheduling)` | Enqueue work and resolve one validated summary or reject. |
| `cancelScope(scope)` | Reject matching active/queued jobs and return the number canceled. Canceling active Worker work terminates that Worker so stale computation cannot settle a newer request. |
| `stats()` | Return `{ active, queued, workerMode, disposed }`. |
| `workerMode()` | Report whether new work currently targets a Worker rather than fallback. |
| `dispose()` | Idempotently reject active/queued work, terminate the Worker, and reject all later builds. |

Client-defined error codes include:

| Code | Meaning |
| --- | --- |
| `building-mesh-input-invalid` | The bounded request snapshot, including a label or code length, is invalid. |
| `building-mesh-aborted` | An `AbortSignal` or `cancelScope()` canceled the job; the error name is `AbortError`. |
| `building-mesh-disposed` | Work was pending during disposal or was submitted after disposal. |
| `building-mesh-worker-protocol` | A response has the wrong owner/ID/status or fails request, schema, count, or buffer validation. The faulty Worker is terminated. |
| `building-mesh-worker-failed` | Worker execution, message decoding, or `postMessage()` failed outside a recognized protocol error. Worker construction unavailability selects fallback instead. |
| `building-mesh-failed` | A Worker supplied no more specific construction error code. |

NCM decoding and placement can also reject with their documented errors, including `building-does-not-fit`. Treat every rejection as terminal for that requested result; never convert one into an empty successful mesh. Worker unavailability may move later queued work to the fallback path, but it does not weaken validation. See [Worker protocol](worker-protocol.md) for the decode-only command-envelope checks and buffer ownership rules.

## Forge and NCF1

NCF1 v14 is a bounded fixed-point format with editable-component and baked-appearance modes. Public helpers cover canonical encoding, decoding, material requirements/proofs, workbench operations, meshing, and runtime caching.

`decodeNcf1()` parsing and canonical acceptance are separate concerns. Chain/runtime consumers should require canonical input where identity, hashing, caching, or proofs depend on a unique byte encoding. Display attributes are not automatically chain-enforced material capacities.

All NCF1 conversion and decode paths enforce the 640-byte format ceiling before copying a BufferSource or decoding Base64URL. The largest canonical unpadded Base64URL body is 854 characters. `forgeCodeToBytes()` rejects cyclic wrappers, non-byte array values, unsupported input types, and invalid caller-supplied byte limits.

Forge v1 keeps gameplay and physical density independent. `attributes.density` and `densityScore` are bounded `1..100` gameplay scores. A particular-smelt attribute wins the recipe/base attribute; an explicit `densityScore` wins both. Only when neither score source exists may physical density supply the lower-priority score conversion, followed by the archetype score.

`densityKgM3` is the separate physical input used for mass. `densityGcm3` is accepted as a conversion input when kg/m3 is absent. The normalized profile preserves both `densityScore` and integer `densityKgM3`; it also exposes `densityKgM3Source` and `physicalDensityFallback`. Explicit physical density must round into `1..50000` kg/m3 or parsing fails; `FORGE_MATERIAL_DENSITY_LIMITS` exposes those bounds. Missing physical metadata uses a deterministic archetype value marked `archetype-fallback`, so old preview inputs remain usable without implying that the fallback is material or chain authority.

All material attributes and heat inherit by physical mass. `massWeight` and its clearer alias `massMicrograms` are the exact integer product `usedVolumeMm3 * densityKgM3`; `FORGE_WORKBENCH_MASS_WEIGHT_UNIT` identifies that unit as `microgram`, and `massMilligrams` is its rounded physical conversion. `mass5g` is the same mass rounded into the NCF1 header's 5-gram unit, saturated to `u16`, and kept at one for a nonempty encodable volume that would otherwise round to zero. `massGrams` mirrors that quantized header value, while `massMilligrams` remains the more precise workbench output. Physical density and its source are not encoded directly: NCF1 retains only `mass5g` and the quantized gameplay scores in `attributes6`. A host must therefore validate material provenance and density metadata before treating a workbench result as authoritative; the chain cannot recover or authenticate those source fields from NCF1 bytes.

## Errors and unsupported environments

Public boundaries should throw or return an explicit unsupported/error result for:

- a missing required canvas;
- unavailable WebGL2;
- unsupported generation or resource-rule versions;
- malformed or oversized NCM/NCF payloads;
- stale snapshot revisions or slots;
- Worker initialization/build failure;
- use after a Worker client has been disposed.

Do not recover from an authority or version error by silently substituting fixture data. Performance fallbacks may move work to the main thread only when they preserve the same data contract.

## Stability labels

Until a formal stable release:

- package-exported codec constants and validated binary limits are protocol-sensitive but still pre-1.0;
- high-level engine and scoped subsystem exports are supported integration surfaces for the checked-out release;
- debug pages, demos, benchmarks, direct filesystem paths, render internals, and unexported helpers are experimental;
- the root barrel is retained for convenience and legacy consumers, not as a recommendation to depend on every exported symbol.

There are no bundled TypeScript declarations at the time of writing. Consumers must not infer a stable schema solely from editor completion or an object observed in one execution path.
