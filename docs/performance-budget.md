# Performance Budget

Mobile-first defaults:

- Clamp DPR to about `1.25` on coarse-pointer devices.
- Keep view distance small by default and make it adjustable.
- Rebuild dirty chunks within a frame budget; never rebuild all chunks every frame.
- Upload GPU buffers only when a chunk mesh changes.
- Use one draw call per visible opaque chunk initially.
- Avoid transparent overdraw unless it is a separate controlled pass.
- Ground decoration must use low-density micro voxel models batched into visual chunks; do not reintroduce flat cutout plant planes.
- Keep shaders simple: texture array sample, basic light, AO, fog.
- Track FPS, draw calls, visible chunks, triangles, buffer memory, and mesh rebuild time.
