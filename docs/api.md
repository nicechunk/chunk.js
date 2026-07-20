# API

Public modules are exported from `../index.js` and `../src/index.js`.

Key exports:

- `ChunkManager`: chunk loading, dirty rebuild, chain delta, pending delta, rollback, confirm.
- `ChunkState`: per-chunk base/chain/pending state.
- `meshChunkOpaque`: CPU opaque terrain mesher.
- `WebGL2VoxelRenderer`: native WebGL2 chunk renderer.
- `TextureArrayManager`: generated material texture array manager.
- `encodeNcm4`, `decodeNcm4`, `ncm4PayloadByteLength`: canonical, CRC32C-protected animated character codec bounded for the 2,048-byte `PlayerAppearance` field.
- `createAvatarMeshFromNcm`, `loadPeasantGuyAvatarMesh`: compatible NCM2/NCM4 voxel avatar decoding into one compact WebGL2 mesh; NCM4 includes a fixed humanoid rig, sparse actions, and prop visibility groups.
- `createAvatarPreviewRenderer`: native WebGL2 avatar preview with explicit NCM4 `action`, `elapsedMs`, or normalized `progress` selection.
- `createCameraState`, `cameraForward`, `cameraViewProjection`: minimal camera helpers.
- `FlyCameraControls`: demo input controls.
- `raycastBlock`: CPU integer voxel raycast.
- `inspectBlock`: block proof/debug data output.
- `BLOCK_ID`, `RESOURCE_ID`, `MATERIAL_ID`, `blockDef`, `materialDef`: block/resource/material registries.
- `generateBaseChunk`, `getBlockAt`, `getResourceAt`: deterministic world/resource APIs.

Solana verification contract:

- `getBlockAt(worldSeed, worldX, worldY, worldZ, generationVersion, options)` is the authoritative deterministic base-world block lookup.
- `getResourceAt(worldSeed, worldX, worldY, worldZ, resourceRuleVersion, { generationVersion, ...options })` must reproduce the same `blockId` and derive `resourceId` from `blockDef(blockId)`.
- Inputs for chain proofs must be integer coordinates plus seed and explicit rule versions. Rendering, camera-relative floats, mesh buffers, shaders, decoration meshes, and local pending deltas are not valid proof inputs.
- Default early production height target is `minY=-32`, `maxBuildY=320`, `maxTerrainHeight=240`, which remains inside the current 3-byte chunk delta Y-offset capacity.
- Natural river/lake water is generated only where the deterministic surface has been carved below the global sea level. Broad river floodplains are part of the canonical integer terrain formula and must remain reproducible by the SDK and Rust verifier.
- Current generation v5 uses a higher deterministic snowline, rarer high-mountain mask, wider open-river floodplains, and deterministic tree density based on integer altitude/moisture/surface/floodplain state. Snowy cedar rendering is visual-only and still verifies as the existing pine tree block/resource data.
- Terrain algorithm changes must keep this path deterministic and should be accompanied by smoke-test updates when versions or resource semantics change.
