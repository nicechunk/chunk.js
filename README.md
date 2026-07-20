# Chunk.js WebGL2 Voxel Engine Lab

This folder is a standalone NiceChunk voxel renderer project. It is served directly by NGINX under `/chunk.js/`, stays outside the Vite app, and does not depend on Three.js or any general 3D engine.

Current production direction:

- Native WebGL2 only.
- NiceChunk-specific voxel world, not a generic engine.
- Integer-only authoritative world, resource, chunk, and mining coordinates.
- Renderer visualizes `base world + chain delta + pending delta`; it is never world truth.
- Chunk meshes are CPU-built with face culling and greedy meshing, then uploaded as compact WebGL2 buffers.
- Materials use a generated texture array, not external texture packs.

Public routes:

- `/chunk.js/`
- `/chunk.js/demo/playable/`
- `/chunk.js/demo/extreme-fps/`
- `/chunk.js/debug/`
- `/chunk.js/debug/materials/`

Directory map:

- `core/`: integer coordinates, deterministic hash helpers, math for render boundary.
- `world/`: block/resource/material registries and deterministic world generation.
- `chunk/`: chunk state, chain/pending delta merge, meshing, chunk manager.
- `renderer/`: native WebGL2 renderer, shaders, buffers, texture array, camera.
- `input/`: integer raycast and controls.
- `debug/`: stats and block inspector helpers.
- `demo/`: runnable pages served without Vite.
- `docs/`: architecture and migration notes.

Cross-repository tests that compare engine visuals with game recipes and chain adapters run from the main integration workspace. The default checks in this repository are self-contained.
