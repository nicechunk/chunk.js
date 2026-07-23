# Renderer Lifecycle

`WebGL2VoxelRenderer` owns a WebGL2 context and every GPU object it creates. Treat it as a resource owner with explicit initialization, context-loss, and disposal boundaries.

## Construction and initialization

Construction stores the canvas and normalized options and installs `webglcontextlost` and `webglcontextrestored` listeners. `init()` then creates:

- the WebGL2 context;
- terrain and avatar programs/uniforms;
- buffer and generated texture-array managers;
- cloud, sky, sun, projected-shadow, overlay, and particle passes;
- depth/cull/blend defaults and canvas sizing.

If WebGL2 is unavailable, high-level capability detection returns an unsupported result. Lower-level direct initialization throws.

Initialization is transactional. If context inspection, shader setup, texture generation, an auxiliary pass, renderer-state setup, resize, or an initialization observer throws, the renderer deletes every GPU object created by that attempt, resets its context-owned references and caches, restores the canvas dimensions, and removes its context listeners. A later `init()` call reinstalls those listeners and starts from a clean state, so callers may correct a transient failure and retry the same renderer instance.

The high-level engine releases a partially created `ChunkManager` and renderer if initialization fails.

## Per-frame ownership

CPU chunk state owns source meshes and committed revisions. The renderer owns their GPU uploads in:

- opaque chunk buffers;
- visual chunk buffers;
- opaque region buffers;
- visual region buffers;
- avatar buffers;
- pass-specific resources.

`prepareChunksForRender()` uploads within a frame budget. When region batching is enabled, the renderer combines chunks into 4 by 4 groups and retires redundant staging chunk buffers. `pruneChunks()` removes GPU state for chunks no longer owned by the world manager.

Application code must not mutate or transfer a mesh buffer while the renderer expects to upload it.

## Animation loop

The high-level engine owns its `requestAnimationFrame` loop:

1. update manager position/load direction;
2. rebuild dirty chunks within the mesh budget;
3. determine visible chunks;
4. prune and prepare GPU buffers;
5. render all passes;
6. emit statistics.

`stop()` halts that loop but retains CPU/GPU resources for a possible restart. It is not teardown.

## Context loss

On `webglcontextlost`, the handler prevents default browser disposal behavior, marks the renderer lost, and stops treating the previous initialization as valid. Every program, texture, VAO, VBO, IBO, framebuffer, and pass object from the old context is invalid after loss.

On restoration, all context-owned buffer caches are invalidated and programs, textures, and auxiliary passes are initialized against the new context. Opaque and visual chunk/region buffers are uploaded again from chunk CPU meshes during normal preparation. Avatar buffer entries are also cleared; the application must call `uploadAvatarMesh()` again from its CPU-owned avatar mesh before that avatar can render.

Context recovery is not complete if terrain returns while avatars or another pass retain old handles. Browser regression coverage should explicitly upload an avatar, force loss/restore, confirm the old entry is invalidated, re-upload the avatar, and verify a new buffer is created before draw.

## Disposal

`WebGL2VoxelRenderer.dispose()` should:

- delete opaque, visual, region, and avatar buffers;
- dispose every auxiliary pass and texture manager;
- delete shader programs;
- clear caches and references;
- remove context event listeners;
- mark the instance uninitialized.

The high-level `engine.destroy()` is idempotent and terminal. It stops animation, calls the owned `ChunkManager.dispose()` to terminate Workers, disposes the renderer, and reports a destroyed status. Calling `start()` after destroy is an error; later `stop()`, `setPaused()`, and `resetCamera()` calls are cleanup-safe no-ops and cannot replace the terminal status.

Lower-level consumers must dispose the manager and renderer they created. Also dispose separate avatar-preview, Forge, smelting, or building Worker/render clients according to their own ownership APIs.

## Secondary renderer factories

`createForgeWorkbenchRenderer()` owns failure cleanup for its construction-and-initialization sequence. If initialization fails, it removes the canvas and document lifecycle listeners and releases every partial program, mesh upload, control listener, resize observer, and material texture before rethrowing. A directly constructed `ForgeWorkbenchRenderer` keeps its lifecycle listeners after a failed `init()` so the caller can correct a transient failure and retry the same reachable instance; `dispose()` remains mandatory when that instance is abandoned. Material-texture rebuilds create the replacement first and swap only after success, so a failed rebuild does not destroy the live texture array.

The avatar and smelting preview factories distinguish caller-owned canvases, existing canvases found in containers, and canvases they create themselves. They attach a newly created canvas only after WebGL, shader, buffer, vertex-array, uniform, and initial model setup succeeds. Failure releases every partial GPU object, while `dispose()` removes only a canvas created by that factory. Callers remain responsible for removing canvases they supplied or already owned.

## Option and capability discipline

Only options normalized by the constructor are supported. Do not document an option merely because a later method reads a similarly named field; add constructor wiring and a regression test first.

Renderer defaults are performance heuristics, not compatibility promises. Record effective DPR, view distance, upload budget, region size, browser, and GPU with a performance report.

## Recommended view cleanup

```js
const engine = await createChunkEngine({ canvas });

if (engine.supported) engine.start();

const cleanup = () => engine.destroy();
addEventListener("pagehide", cleanup, { once: true });
```

Framework components should call `destroy()` from their unmount/disconnect hook and remove any application listeners or chain subscriptions they own.

## Lifecycle tests

Cover at least:

- unsupported WebGL2 without leaked Workers;
- renderer initialization throwing after manager creation;
- repeated `start()` and `stop()`;
- idempotent `destroy()`;
- `start()` rejected after destroy;
- all chunk Workers terminated on destroy;
- all GPU resource maps empty after dispose;
- context loss/restoration for terrain, visual regions, avatars, and auxiliary passes;
- failures inside a partially initialized auxiliary pass and after the final resize stage, including exact GPU deletion, canvas restoration, listener cleanup, and successful retry;
- resize and DPR changes without stale viewport state.
