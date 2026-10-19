# Terrain render sections and immutable commits

## World contract

The canonical chain chunk remains 16 by 16, Y=-32 through 320 inclusive.
World generation, seeds, block IDs, chain addresses, account layouts, and saved
NCM/NCM3 models are unchanged. Browser rendering uses 16-layer sections anchored
at `minY`. The default 353 layers occupy 23 sections; section 22 contains Y=320.
`sectionIndexAt()` uses floor division, including at negative coordinates.

The Game host continues receiving chain ChunkState objects. The renderer expands
their `renderSections` internally. Host GPU pruning retains parent ownership;
a section ID is not an independent chain chunk ID.

## Revisions and task input

Each section owns an instance generation, data revision, geometry halo revision,
light revision, separate opaque/visual mesh revisions and commit tokens, dirty
reason, oldest wait time, task state and visual retry state. GPU context
generations and resource identity belong to the renderer and are independent
from these CPU revisions. An unrelated section edit does not invalidate a
dispatched task. A changed dependency, replaced instance or changed material
configuration rejects it.

Worker payloads capture the section's final edits, one-cell geometry dependencies,
separate tree edits, finite sky/local light dependencies, and a compact column-top
halo covering the 14.3-cell sun sampling footprint. The generated base profile
and tree instances travel with section remeshes. Structured cloning occurs in
one synchronous dispatch; no partly mutated payload is published.

The normal synchronous fallback uses the same bounded section builder. During
continuous near-field editing, accurate current section replacements provide
progress while obsolete full/section Worker results continue to be rejected.
The compensation replaces the complete section, including removed faces; it
does not overlay new faces onto obsolete geometry. A task remains a bounded
section even if it overruns a very small wall-clock budget on a slow device.
The code does not promise a universal 4 ms per-task deadline.

Range changes reserve chunk identities without eagerly reconstructing every
new base when Workers are unavailable. The dirty scheduler generates those
bases progressively, closest first. An explicit synchronous `ensureChunk()`
still makes that requested base ready immediately. Collision reads for a
reserved, unbuilt chunk use canonical procedural reconstruction until its base
is committed; a cold view expansion does not reinterpret those cells as air.

## Geometry

The profile mesher checks final six-neighbour state for explicit edits and the
owning chunk's boundary cells exposed by neighbour edits. Candidate order is
canonical Y/Z/X in both synchronous and Worker paths. Profile top faces check
the actual block above them. A section boundary never creates a fictitious
world-bottom face.

Synchronous manager and Worker tasks both use indexed neighbour edits. Callers
without an explicit neighbour-edit payload use a one-cell perimeter scan of
this section. At canonical dimensions its upper bound is 1,024 boundary cell
visits, not a scan of all 353 layers. This compatibility fallback is local and
measurable. Profile cliffs and final edit candidates have separate ownership;
an edit does not trigger an extra five-layer scan of every solid column.
`meshChunkOpaque()` remains an independent full final-voxel
debug/reference path. The test oracle is independently implemented from final
six-neighbour state, with material, normal, indexed triangle coverage, duplicate
coverage, degenerate triangle and index-range checks.

Water surfaces represent final fluid segments after removal, placement and caps.
The profile and delta paths share visual-cell ownership. A same-value delta does
not emit a second plant. Generated visual-free sections commit a valid empty
visual mesh; a visual exception is a separate failed revision and preserves its
previous channel until retry succeeds. Retry delays grow from 100 to 3,200 ms.

## Lighting

Sun/sky/local light are separate packed fields. A bounded six-neighbour transport
field includes geometry/model bounds and a complete halo. Face samples search
the exact reachable attenuation neighbourhood with shared lazy cell queries.
Buried solids outside those paths require no material reconstruction. A dense
source-propagation reference checks byte equality at radii 1, 2, 4 and 8.
The default propagation radius is four cells; it is local illumination, not
unlimited global illumination.
Opaque cells block transport. Column-top changes invalidate affected sky below,
and near edits invalidate local light on both sides of a section boundary.
Sun shadows have their separate 14.3-cell column dependency and invalidate on
placement, rollback, authoritative replacement, hint expiry and unload.

The low vertex flag bits 0..2 retain their existing meanings. Bit 7 identifies
baked lighting, bits 3..6 contain local light, and the high byte contains four-bit
sun and sky values. The renderer has an independent cave ambient floor for
playability; it does not turn full sunlight back on in a closed cavity.

## Precision and compatibility

Packed vertices retain the 20-byte layout. Their fourth Int16 position component
contains a positive scale. Section Y coordinates are relative to `mesh.originY`.
The shader, frustum, CPU diagnostics and merge helpers read that scale and origin.
Legacy whole-mesh APIs select a safe origin/scale and reject out-of-range final
vertices instead of allowing signed Int16 wrap. The top of a block at Y=511 is
512 and is validated as a vertex. Greedy row/visited sets support the existing
1..64 chunk-size contract, including full rows across positions 31 and 32.

Legacy readers can request a combined CPU mesh, which is packed lazily.
Visibility and the normal renderer never force this packing. Material ranges
and sortable blend units are prepared in the section task/Worker, validated on
receipt and reused during GPU upload.

## Snapshot application and diagnostics

Large authority snapshots prepare normalized records, final maps, per-column and
per-section indexes, light tops and neighbour invalidation plans in a yieldable
isolated generator. Commit validates source instance, epoch, chain revision,
authority input revision and base identity. It swaps references and updates bounded section
metadata. A collider cannot see a half-applied snapshot. Pending edits and hints
cannot change during preparation unnoticed.

`authorityInputRevision` advances for accepted pending/remote/chain changes,
rollback, hint expiry, base setters and newer authority watermarks. Pure render
halo or lighting `markDirty()` calls advance render revisions without restarting
an otherwise valid authority preparation. Base identities and the render plan's
instance guard remain mandatory. Tests reject real input changes even when
they reuse a Map/array or do not change visible geometry, and prove progress
during continuous neighbour edits. The broader `version` remains diagnostic
render state, not a proxy for authority input identity.

The manager keeps an instance-bound set of chunks with active remote overlays.
Per-frame expiry visits that set instead of scanning a large view of clean
chunks. Direct state hint insertion, confirmation, authoritative clearing,
read-triggered expiry, unload and disposal maintain the same ownership index.

`ChunkManager.diagnostics()` reports resident CPU mesh array bytes (including a
materialized legacy aggregate), queue ages, cache counts, generations and revision
relationships. Mesh stages report actual voxel requests, unique source queries,
actually queried lighting cells and typed-array cache bytes. Lighting also reports
its conservative domain size separately. The 4,096-cell opaque section
budget is not reported as the total work: halo, lighting and visual work also
count. GPU timing and GPU resource ledgers are documented separately in
[render-gpu-lifecycle.md](render-gpu-lifecycle.md).

## Verification

Run `npm run build:browser` and `npm run check` in the engine. The host must build
its Vite runtime and validate the actual self-contained Worker referenced by the
Game entry. Use `NICECHUNK_TEST_CONCURRENCY=1` when sharing a CPU-limited machine
with a software WebGL endurance test. Software rendering and controlled local
Guardian tests do not establish performance on a user's hardware or public
Guardian deployment. The delivery's per-item evidence table records the exact
executed tests, source fingerprints, durations and remaining external checks.
## Surface pickup masks

Authoritative surface pickup masks remain column indices (`z * chunkSize + x`)
on the parent ChunkState. A host publishes a new mask and marks the chunk dirty;
the resulting section revisions invalidate earlier visual builds. Section Worker
requests own a copied mask, just like their captured final deltas, so a collected
surface model cannot return after a rebuild or an in-flight array mutation.
The main-thread section view inherits the same mask. Real Worker regressions
compare complete vertex/index bytes and reject a result after a later pickup.
