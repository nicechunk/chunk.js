# Architecture

Chunk.js is NiceChunk-specific and native WebGL2-only.

Core pipeline:

1. Integer coordinate helpers map world coordinates to chunk/local coordinates.
2. Deterministic world generation creates a compact `baseProfile` from seed and rule versions for unmodified chunks; arbitrary default block lookup is still reproducible from integer coordinates.
3. `ChunkState` keeps base profile/resolver, chain deltas, pending deltas, reveal state, dirty state, and mesh cache separate.
4. `ChunkManager` loads chunks around the player, rebuilds only dirty chunks within a frame budget, and exposes integer `getBlockAtWorld()`.
5. `chunk-mesher` performs opaque face culling and greedy meshing into compact packed vertex/index buffers.
6. `WebGL2VoxelRenderer` uploads changed chunk meshes into VAO/VBO/IBO handles and draws visible chunks with a generated texture array.
7. CPU integer raycast returns block coordinates for mining/proof flows; WebGL picking is not authoritative.

The renderer does not decide resources, mining legality, or chain state. It only displays the current merged visual state.

Default profiles accelerate unmodified terrain only. Final state remains `pending delta > chain delta > deterministic base`, which keeps Solana PDA destruction/placement data compatible with rendering and proof flows.
