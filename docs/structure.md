# Structure

- `core/`: integer coordinates, deterministic hashing, render-boundary math.
- `world/`: deterministic generation plus block/resource/material registries.
- `chunk/`: chunk state, delta merge, chunk manager, mesher.
- `renderer/`: WebGL2 renderer, shaders, buffers, texture array, camera/frustum helpers.
- `input/`: raycast and controls.
- `debug/`: stats and block inspector.
- `demo/`: direct browser demos.
- `examples/`: small integration pages.
- `docs/`: architecture notes.
- `src/`: compatibility re-export surface for older imports.
- `engine/`: compatibility re-export surface for direct NGINX routes/imports.
