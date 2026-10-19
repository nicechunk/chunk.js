# WebGL2 upload, material passes, and diagnostics

## CPU commits and GPU ownership

A render section is an independent upload unit. `flattenRenderSections()` accepts
legacy chunks and parents with `renderSections: Map`. The origin in the draw is
`(chunkX * chunkSize, mesh.originY ?? section.originY ?? 0, chunkZ * chunkSize)`.
Positions remain relative to this origin. The fourth packed position component
is the actual position scale; region grouping never adds offsets to packed int16
positions.

A GPU entry records the source object, its instance generation, committed channel
revision and commit token, CPU mesh/storage identity, context generation, and GPU
handle. Reusing a coordinate, a revision, or equal vertex/index counts does not
reuse another instance's buffers. Reusing an object pool entry requires its
`generation` to change. Replacing an immutable mesh or its storage changes its
token even if the revision did not change. Draws can retain the previous commit
from the same live instance while an upload is pending, but never from an unloaded
or replaced instance.

The legacy `useRegionBatching` API now groups **residency**, not an indivisible
repacked draw. Region members own independent buffers. A camera visibility change
does not change membership or upload geometry. A member edit replaces only that
member; pruning frees members independently. This trades additional draw calls
for bounded edit uploads. Static regional draw-call aggregation is not currently
performed in the background. It is not reported as a performance improvement.

## Upload transactions and budgets

`BufferManager.beginChunkBuffers()` allocates staging VAO/VBO/IBO storage.
`advanceChunkBuffers()` uploads byte slices using `bufferSubData`; completion is
separate from allocation. A new handle and channel token are committed only after
all allocation/upload stages succeed in the same context generation. Until then
the old handle remains owned and drawable. An allocation returning `null`, a GL
error without a JavaScript exception, or context loss releases the partial
transaction, leaves upload flags false, and schedules retry.

The frame scheduler defaults to 4 MiB of chunk upload bytes, a 4 ms soft CPU
scheduling deadline, and the existing task count limit. A large transfer advances
across frames rather than bypassing the byte budget. The CPU deadline determines
whether another task starts; it cannot preempt a driver allocation. A single
legacy full mesh still has an indivisible first material-classification step.
The normal section path supplies verified material metadata from its build task,
so the main thread does not reclassify all vertices/triangles. These limits are
not a guarantee that every driver call or arbitrary legacy mesh finishes in 4 ms.

`prepareChunksForRender(chunks, { deadline })` also accepts an absolute
`performance.now()` deadline from the host streaming budget. An expired explicit
deadline starts no upload. Retry cooldowns do not consume a channel turn. Near
terrain and visual channels share one priority queue; waiting frame debt and age
provide progress under sustained nearby edits. Partial transfers reset debt only
after real byte progress, and preserve their staging transaction across turns.

Preparation updates backing size and camera aspect before visibility. A
`ResizeObserver`, when available, supplies subsequent canvas dimensions without
per-frame layout reads; the fallback reads once in a prepare/render pair. A
short-lived scalar input record validates source identity, instance generation,
managed active-list revisions, channel storage and bounds before render reuses
the prepared list. Mutable legacy section maps are conservatively rechecked.
CPU upload candidates remain independent from committed GPU draw entries.

A failed channel retries after 250 ms by default (`uploadRetryMs`). Its signature
never advances on failure. CPU models registered during context loss are pending
work, not successful GPU uploads.

## Context loss and model recovery

All allocation, upload, and public draw entries check loss/disposal before doing
GPU work. Context loss is a pause, including loss halfway through initialization.
Loss does not detach restoration listeners. GPU ownership records and queries
are abandoned as invalid; the CPU avatar registry survives. Restoration creates
new programs, textures, auxiliary passes and buffers with a new context
generation. Avatar restoration continues in bounded batches of two models from
render/prepare calls, without changing appearance or reconnecting the game.

The CPU registry includes default, local, remote and equipped avatar geometry.
Several IDs using the same CPU mesh share one GPU allocation with reference
counting. Removing one alias does not delete another alias's live buffers.
Failed replacements retain their old handle and retry automatically. A disposed
renderer clears the registry and detaches listeners; late load completions or
restoration events cannot resurrect it.

Animated entities additionally own independent persistent pose storage: two CPU
arrays and up to two ping-pong VBO/VAO pairs sharing the model's immutable IBO.
Each visible entity generates/transfers at most one pose per frame. The inactive
buffer and matching part-visibility ranges commit together only after successful
validation; failure keeps the previous complete GPU pose and CPU sort data.
Conservative animation envelopes include equipment, cloth and NCM4 ancestor
pivots before pose generation. Offscreen body instances are pruned; projected
shadow candidates are considered separately by their projected quad and obey the
actual `maxDynamicShadowCasters` limit. The gameplay shadow policy remains off.

NCM4 pose preparation caches the per-bone rotation terms once per pose and the
unposed cuboid face points by geometry values. Parent chains still execute in the
original order with double precision between ancestors and the same final
Float32 write. Normals are calculated once per face. This avoids per-vertex trig,
rotation lookups and intermediate vector allocations without introducing GPU
skinning, changing animation frequency or using a lower-detail model. Live
pivot/parent/action changes refresh the pose terms, and changed cuboid dimensions
invalidate cached face points.

## Material ranges and transparency

`prepareMeshDrawRanges()` partitions indices by material semantics, regardless of
whether the mesh arrived in the opaque or visual CPU channel:

| Range | Depth test/write | Blending | Alpha policy |
| --- | --- | --- | --- |
| opaque | on/on | off | opaque material |
| cutout | on/on | off | discard below 0.5, surviving alpha is 1 |
| shadow | on/off | source alpha | separate projected/surface shadow pass |
| blend | on/off | source alpha | true material alpha |

Opaque and cutout geometry from **both channels** and opaque avatars complete
before blended geometry. All helpers restore depth writes, blending and culling.
The default renderer queues water, ice, glass, transparent avatar/equipment
triangles, preview geometry and particle instances together in eye-space depth
order, recomputed for the actual camera. Equal depths use a stable identity key.
Invisible avatar fades are skipped. Particle instances are a bounded pool.

Model construction records part index ranges and possible blend material paths.
Each pose updates visible ranges while it already visits parts. Known hidden
equipment/groups leave both the opaque index draws and transparent queue source;
an ordinary opaque body skips per-triangle blend classification. Unknown external
mesh layouts retain the conservative per-triangle fallback. A texture replaces
vertex color and alpha in the avatar shader: zero vertex alpha alone never proves
that a textured triangle is invisible.

The globally sorted queue is divided into contiguous compatible segments. Each
vertex-storage owner has a separate dynamic sorted EBO and dedicated VAO; the
canonical opaque/cutout/shadow index buffer remains immutable. The stream reads
indices from the currently committed GPU handle, including shared-page rebasing.
It supports 16/32-bit indices, has an 8 MiB reusable CPU index-capacity bound, and
falls back to canonical per-unit draws in the same global order on allocation or
upload failure. A stream owner for an animated entity survives pose VBO swaps;
its VAO attributes are rebound when the VBO changes. Unused owners are pruned.

Particles prepare their complete ordered instance data once per frame. Each
contiguous segment uses instance attribute byte offsets to select its interval;
WebGL2 base-instance support is not assumed. Empty input transfers no data.

This is sorted source-alpha transparency, not order-independent transparency.
Terrain/model triangles are sortable units; large greedy triangles, intersecting
triangles and cyclic overlap can still produce ordering artifacts. Individual
particle cubes are sorted as units. There is no claim of exact per-pixel ordering
for interpenetrating geometry, and no mandatory OIT extension or expensive
fallback. Draw counts can increase with the number of blended triangles.

Build tasks may supply `materialPassLayout: 1`, contiguous `drawRanges`, and
`blendUnits`. Before reusing these, upload validation checks complete index
coverage, aligned bounded ranges, unit counts, unique offsets, pass membership,
and finite three-component centers. Malformed metadata is rejected rather than
silently hiding faces.

## Texture quality

The renderer's `textureQuality` defaults to `balanced`; direct uses of
`TextureArrayManager` retain the compatible `pixel` default.

| Preset | Minification | Magnification | Additional features |
| --- | --- | --- | --- |
| pixel | nearest | nearest | one level |
| balanced | nearest mip / linear level blend | nearest | RGBA mip pyramid |
| high | trilinear | nearest | anisotropy capped at 4 when available |

Cutout mip generation preserves the nearest achievable discrete alpha coverage.
A 1×1 mip cannot represent fractional binary coverage exactly. Shader derivatives
come from unwrapped UVs via `textureGrad`, so `fract()` repeat boundaries do not
select an incorrect LOD. Geometric MSAA can be requested with `antialias: true` at
context creation; it is optional, not a requirement for lower capability devices.
No full-screen postprocess or high-cost extension is enabled by default.

## Water precision

Water view vectors use `p - uCameraLocalEye` in the same world-axis-relative space
as normals and lighting. They do not assume the integer origin is the eye.
Wave numbers lie on a 256-block periodic lattice. The CPU reduces the double
precision world origin before sending a bounded phase; the GPU never rebuilds an
absolute float32 position. Cell hashes use integer origin cells plus local
fractions for each cell size. Negative coordinates use floor and positive modulo.
Particles likewise subtract the integer world origin on the CPU before packing
float32 instance positions.

The material's periodic wave lattice is an explicit aesthetic choice. It avoids
large-world phase jumps; it is not an unbounded nonrepeating fluid simulation.
Tests cover signed `2^20` and `2^24`, equivalent eye encodings, and split chunks.

## Diagnostics

`renderer.diagnostics({ maxEntries: 64 })` reports:

- Unique live buffer/texture bytes, including screen-excluded and staging
  allocations; transition peaks; cumulative real buffer transfer bytes. Texture allocation bytes are separate.
- Context generation, allocation/upload failures, oldest upload wait, bounded
  cache size, GPU channel/instance/dependency versions, and commit tokens.
- Per-entry CPU mesh-ready, GPU-ready and first submitted draw timestamps.
  Enabled render logging emits `mesh-gpu-ready` and `mesh-first-draw` once per
  commit; it does not scan the world each frame. These are submission timestamps,
  not proof of display scanout or a hardware GPU completion measurement.
- Retained CPU mesh buffers and the bounded shared material-tile cache separately.
  The host manager supplies the remaining world CPU mesh/cache totals.
- CPU stage distributions from the bounded `RenderStageStats` recorder. Callers
  may record delta merge, authoritative apply, mesh build and other stage times.
- GPU time only from asynchronous `EXT_disjoint_timer_query_webgl2` results, with
  at most four queries and generation ownership. Unsupported, waiting, disjoint
  and allocation-failed states use `null`, never fabricated 0 ms. A reported GPU
  time is the latest completed query, not necessarily the current frame.

Resource counts are an application ledger, not physical driver memory or the
browser's full heap. Shared handles are counted once; context loss resets live
ownership, and dispose returns the GPU ledger to zero. Peaks span the renderer's
lifetime. The material tile cache is intentionally shared and bounded at 256
entries. Diagnostic snapshots sort bounded CPU samples on demand, not per voxel.

## Validation tools

- `node --test tests/render-repair-gpu.test.mjs` covers identity reuse, every
  allocation stage, GL error injection, upload slicing, pass validation, retries,
  aliases, loss during init, texture fallback, water cells and bounded metrics.
- Existing renderer context, avatar held-material and forge texture tests retain
  their correct behavior assertions.
- `tests/transparent-streaming.test.mjs` checks committed sorted-index ownership,
  canonical EBO isolation, both index widths, shared origins, allocation failure,
  particle intervals, independent real poses, visibility/cooldown/fairness,
  prepared-frame invalidation and budgeted material-partition steps.
- `tools/render-gpu-long-session.mjs` runs a controlled 60-minute renderer and real
  module Worker component session. It explicitly identifies synthetic local
  dig/backfill, view-distance changes, periodic loss/restore, pruning, its renderer
  environment and scope. It performs no wallet, RPC or production transaction.
  This component tool is not a full two-client Guardian integration test.

Real browser evidence must state whether ANGLE uses software rendering. A shorter
session, a Mock GL test or an ordinary GPU counter is not a 60-minute hardware-GPU
world session.
