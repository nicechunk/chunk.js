# Architecture

Chunk.js is a NiceChunk-specific native WebGL2 runtime. It combines deterministic world reconstruction, layered chunk state, CPU meshing, browser Worker orchestration, rendering, input/collision helpers, NCM codecs, building support, and the Forge runtime.

It is not chain authority and is not a generic game engine.

## Authority and data flow

```text
32-byte seed + supported rule versions + integer coordinates
                              |
                              v
                   deterministic base world
                              |
confirmed PDA snapshot ------+------ local pending transactions
              \              |              /
               +------ ChunkState merge ---+
                    pending > chain > base
                              |
                         ChunkManager
                  queue / neighbors / retries
                              |
                    module Worker or fallback
                   base profile + tree instances
                   opaque mesh + visual mesh
                              |
                    WebGL2VoxelRenderer
             camera-relative, non-authoritative view
```

Only the seed, supported versions, integer coordinates, validated chain state, and the relevant governed rule data participate in authoritative reconstruction. Meshes, colors, camera transforms, animation, AO, fog, shadows, and pending local edits do not.

## Coordinate boundary

World, chunk, local block, mining, and proof coordinates are integers. `core/coordinates.js` performs world/chunk conversion, while `core/hash.js` provides deterministic integer hashing and noise helpers.

Rendering is allowed to use floating-point camera-relative coordinates after the authoritative block has been selected. That boundary prevents visual precision or camera state from changing proof input.

At external proof boundaries, use an explicit 32-byte seed or 64-character hexadecimal encoding. Text seed normalization exists for repository/demo convenience and must not silently become a new cross-language protocol.

## World layer

`world/world-generator.js` owns deterministic terrain, water, surface block, and tree reconstruction. Unmodified chunks use a compact `baseProfile` rather than materializing every block. Arbitrary block lookup remains reproducible from the same inputs.

`world/block-registry.js`, `world/material-registry.js`, and `world/resource-oracle.js` map generated blocks to runtime and resource metadata. Resource lookup reconstructs or accepts a block, then derives its resource through the block registry.

The release supports generation version `5` and resource-rule version `1`. Public configuration and lookup boundaries reject all other versions. See [World generation and versioning](world-generation-and-versioning.md).

Trees are part of deterministic spatial generation because trunks and leaves occupy multiple coordinates. Other natural surface objects are governed by validated `SurfaceDecorationTable` PDA rules. `world/surface-decoration-rules.js` compiles injected rules; its bundled defaults are fixtures, not production authority.

## State layer

`chunk/chunk-state.js` keeps these concerns separate:

- deterministic base profile/resolver;
- confirmed chain deltas;
- pending local deltas;
- per-block and chunk reveal state;
- chain revision, snapshot token, and snapshot slot;
- dirty and committed mesh revisions;
- opaque and visual CPU meshes.

Final state is always:

```text
pending delta > chain delta > deterministic base
```

A confirmed transaction can be newer than a lagging RPC snapshot. Snapshot metadata and the protected-unobserved set prevent an older full snapshot from temporarily erasing that confirmed delta. Hosts must preserve this concurrency protocol rather than replacing maps directly.

Chain and pending batches are normalized and evaluated against temporary Maps before one commit. A malformed later entry therefore cannot leave an earlier entry applied, invalidate a merged-map cache, advance a revision/version, or dirty a mesh. Full snapshot replacement uses the same transaction boundary, rejects deltas owned by another chunk, and mutates the protected-unobserved set only after validation and stale-revision/slot checks succeed. The manager also preflights batch size, touched-chunk count, configured vertical bounds, and projected resident delta counts before loading the first target chunk. Chain and pending Maps share one resident-entry budget because overlapping entries still consume two retained objects even though pending wins during final resolution.

## Scheduling and Worker layer

`chunk/chunk-manager.js` owns loaded chunks, visibility memory, build queues, retry state, Worker instances, and neighbor access. It prioritizes nearby and forward chunks, transfers compact delta arrays, and applies completed results only to the matching task/version. Unknown-size iterables are collected only up to the Worker payload ceiling; known collection sizes are rejected before allocating their packed `Int32Array`.

`chunk/chunk-build-worker.js` reconstructs the base profile and trees, applies local and neighbor overrides, creates an opaque mesh and a visual mesh, and transfers typed-array results back to the manager. Worker construction uses `new URL(..., import.meta.url)` and requires a valid HTTP(S) module graph.

The sender relinquishes a transferred `ArrayBuffer`. Main-thread and Worker fallbacks must expose the same public result schema. See [Worker protocol](worker-protocol.md).

## Meshing layer

`chunk/chunk-mesher.js` has distinct opaque and visual paths:

- opaque terrain uses face culling, a fast heightfield path where valid, and greedy meshing;
- visual meshes contain water and non-colliding decoration geometry;
- packed terrain vertices use a 20-byte layout and a 1/64 position scale;
- index buffers select 16-bit or 32-bit storage based on vertex count.

Meshing is derived display data. A mesh is replaceable and must never be used as proof of a block or resource.

## Renderer layer

`renderer/webgl2-renderer.js` owns the WebGL2 context and its programs, texture array, per-chunk and region buffers, avatar buffers, sky, clouds, sun, projected shadows, overlays, and particles.

Default region batching combines chunks in 4 by 4 groups for opaque and visual passes. Therefore one visible chunk is not equivalent to one draw call.

The renderer maintains CPU-side references or source meshes needed to recreate GPU state. Context loss invalidates all WebGL objects. Teardown must dispose GPU objects and remove context listeners. See [Renderer lifecycle](renderer-lifecycle.md).

## Input and physics

- `input/raycast.js` performs CPU voxel DDA and returns integer block coordinates.
- `input/collision.js` prepares yaw-rotated collision boxes.
- `input/camera-collision.js` sweeps the camera segment against world collision.
- `physics/motion-collision.js` provides AABB and swept-AABB helpers.
- `physics/voxel-item-collision.js` resolves avatar tool motion and mining poses.

These helpers consume a world-state interface; they do not validate transactions or chain ownership.

## NCM and construction

`ncm/blueprint-codec.js` handles NCM2 compatibility and NCM3 declarative blueprints. `construction/building-parser.js` converts NCM3 into integer voxel placement with translation and quarter-turn rotation. `construction/building-mesher.js` partitions render and collision data by chunk. `construction/building-mesh-client.js` optionally delegates the build to a module Worker.

`ncm/character-codec.js` implements bounded, canonical, CRC32C-protected NCM4 character data with a fixed rig/action vocabulary. CRC detects corruption; it does not identify an author or account.

## Forge

`forge/forge-core.js` implements NCF1 v14 with Q6 fixed-point values and a 640-byte raw ceiling. NCF1 supports editable component data and baked appearance data. Other Forge modules implement workbench operations, spatial validation, dyes, meshing, material proof helpers, and an LRU runtime cache.

The encoded equipment header, decoded geometry, visual statistics, material capacity, and chain-enforced effects are distinct trust domains. See [Trust boundaries](trust-boundaries.md).

## Public module graph

The `.`, `./src`, and `./engine` package exports are full convenience/legacy barrels. The narrow package surfaces are:

- `./engine/create`
- `./play`
- `./world`
- `./renderer`
- `./capabilities`
- `./math`
- `./ncm/blueprint`
- `./ncm/character`

Native browser ESM fetches and evaluates the complete graph behind an imported module. Consumers should choose the narrowest available export and treat unexported filesystem paths as internal.

## Lifecycle

The high-level `createChunkEngine()` owns its `ChunkManager` and renderer. `start()` and `stop()` control the animation loop; `destroy()` is the terminal boundary. It stops animation, terminates owned chunk Workers, and disposes renderer resources. Lower-level consumers are responsible for disposing each manager, renderer, and auxiliary Worker client they construct.

Initialization failure must also release partially constructed resources. Destruction should be idempotent so view teardown can call it defensively.

## Non-goals

Chunk.js does not currently promise:

- WebGL1 or server-side rendering;
- a stable 1.0 API or binary-format policy beyond the checked-out release;
- npm registry availability while `private: true` remains set;
- broad cross-browser support without recorded evidence;
- transaction, account-owner, PDA-address, custody, or signature validation;
- production surface-decoration defaults without validated host rules;
- stable direct imports of files outside the package `exports` map.
