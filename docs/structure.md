# Repository Structure

This map describes the standalone Chunk.js repository. Directory presence does not make every file a stable public API; package boundaries are defined by `package.json`.

## Runtime foundations

- `core/` — integer coordinates, deterministic hashes/noise, constants, and render-boundary math.
- `world/` — deterministic terrain/tree generation, block/resource/material registries, and surface-decoration rule compilation.
- `chunk/` — `ChunkState`, chain/pending merge, `ChunkManager`, module Worker, opaque/visual meshing, and delta packing.
- `renderer/` — WebGL2 programs, buffers, texture arrays, camera/frustum helpers, world passes, avatars, Forge views, previews, overlays, and particles.
- `input/` — controls, collision-box preparation, camera collision, and voxel raycast.
- `physics/` — motion/AABB and avatar-tool collision helpers.

## Formats and higher-level systems

- `ncm/` — NCM2/NCM3 blueprint compatibility and NCM4 character codec.
- `construction/` — NCM3 building parsing, integer placement, chunk meshing/collision, and an optional Worker client.
- `forge/` — NCF1 codec, material/proof helpers, workbench operations, dyes, meshing, grip validation, and runtime cache.
- `engine/` — high-level engine creation and compatibility entrypoints.

## Public entrypoints

- `src/index.js` — complete convenience/legacy barrel.
- `src/world.js` — narrow world entry.
- `src/renderer.js` — narrow WebGL2 renderer entry.
- `src/capabilities.js` — capability detection entry.
- `src/math.js` — shared math entry.
- `play.js` — curated game-facing browser graph.
- `index.js` — source barrel behind the legacy entries.

The `.`, `./src`, and `./engine` package paths resolve to the full barrel. Narrow exports also include `./engine/create`, `./play`, `./world`, `./renderer`, `./capabilities`, `./math`, `./ncm/blueprint`, and `./ncm/character`. A source file that is not in the `exports` map is internal to package consumers.

## Runnable and diagnostic content

- `demo/` — direct browser demos, including the simple and playable runtimes.
- `examples/` — small integration examples.
- `debug/` — capability, material, and render diagnostics; some pages require wider-host resources.
- `index.html` — repository landing page.

These paths require HTTP(S). They are development surfaces, not evidence of a stable application API.

## Verification and maintenance

- `tests/` — recursively discovered self-contained tests plus manifest-declared tests under `tests/host-integration/`.
- `benchmarks/` — explicit performance experiments; results require environment metadata.
- `tools/` — repository policy, static checks, and test orchestration.
- `docs/` — runtime, integration, governance, and operational documentation.
- `.github/` — continuous integration, ownership, and contribution templates.

## Dependency direction

The intended direction is:

```text
core
  -> world
  -> chunk
  -> renderer / input / physics
  -> engine and application integrations

ncm -> construction -> renderer integration
forge -> Forge renderer/application integration
```

Lower layers must not import host application code. The standalone test gate must not import files above the repository root. Host-coupled fixtures belong to `npm run test:integration`.

## Host-owned resources

This repository intentionally does not contain all NiceChunk host data. Notable host boundaries include:

- validated `SurfaceDecorationTable` PDA data;
- `/rules/smelting-rules.json` for the smelting debug page;
- `/play/locales/en.json` for optional debug labels;
- Solana RPC/account ownership, PDA address, signature, and custody validation;
- external NCM models or other deployed assets.

The default avatar code embedded in `renderer/avatar-mesh.js` is a repository fallback. Optional fetched avatar URLs are host resources and retain their own license/status.

## Source synchronization boundary

The standalone Git repository and the website runtime source currently have a shared-file relationship but are not one automatic source tree. Repository governance, MIT metadata, and `.github/` files belong here. Copying shared runtime files into or out of Apache-2.0 repositories requires explicit authorization and a per-file license review.

Do not use an unreviewed whole-tree `rsync --delete`, copy internal development notes into this repository, or assume a file inherits compatible terms merely because it has the same path elsewhere.
