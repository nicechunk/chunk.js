# Cooperative CPU mesh builds

Terrain, building preparation and building result validation expose synchronous
iterators for hosts that need to spread CPU work across event-loop turns. These
interfaces change scheduling, not geometry, formats, world rules or validation.
The existing synchronous functions drain the same iterator implementations.

## Interfaces

All options below preserve the existing options for the corresponding
synchronous function. `workBudget` defaults to 256 and accepts integers from 1
through 4096.

| Module | Iterator | Completed value |
| --- | --- | --- |
| `chunk/chunk-mesher.js` | `meshChunkOpaqueSteps(chunk, options)` | Opaque mesh |
| `chunk/chunk-mesher.js` | `meshChunkOpaqueFastSteps(chunk, options)` | Profile mesh, or the ordinary opaque fallback |
| `chunk/chunk-mesher.js` | `meshChunkVisualSteps(chunk, options)` | Visual mesh |
| `chunk/chunk-mesher.js` | `packChunkVerticesSteps(vertices, originY, options)` | Packed vertex bytes, including `positionOriginY` |
| `chunk/chunk-mesher.js` | `buildGeneratedVisualCandidatesSteps(view, options)` | Build-local candidate summary, or `null` for the full fallback |
| `ncm/blueprint-codec.js` | `expandBlueprintSteps(blueprint, options)` | Ordered cuboid operations |
| `ncm/blueprint-codec.js` | `voxelizeSteps(input, sizeOverride, options)` | Final voxel Map in the original insertion order |
| `construction/building-parser.js` | `parseNcm3BuildingSteps(code, options)` | Parsed building |
| `construction/building-parser.js` | `createBuildingPlacementSteps(buildingOrCode, foundation, options)` | Placement |
| `construction/building-mesher.js` | `createBuildingChunkMeshesSteps(placement, options)` | Complete building chunk array |
| `construction/building-mesh-result.js` | `createBuildingMeshResultSteps(building, placement, chunks, options)` | Worker-compatible result summary |
| `construction/building-mesh-result.js` | `validateBuildingMeshResultSteps(input, options)` | The exact owned input result after complete validation |

The candidate options can supply `profile` and `finalDeltas`. Result validation
accepts `request` for the existing request/envelope binding. Vertex packing takes
its origin as the second argument; blueprint voxelization keeps `sizeOverride`
as the second argument even when the input is a blueprint.

## Iterator and ownership contract

`iterator.next()` returns either a progress token
`{ done: false, value: { phase, workUnits } }` or the complete result
`{ done: true, value: result }`. Progress tokens contain no mesh buffers, partially
validated result, or partial world state. A scheduler can run multiple steps
within its time budget, then resume on a later event-loop turn. The caller must
inspect the completed value rather than treating progress as a result.

The host retains an immutable voxel/access, placement or result snapshot for the
iterator's lifetime. It must reject a completed result whose authority revision,
chunk generation, placement request, or job ownership has changed. Suspending a
generator does not make reads from a live mutable chunk into a snapshot.

Each build owns its in-flight face groups, greedy rows, lookup/light fields,
writers, collision masks and output buffers. Builds may be interleaved without
sharing that output. These iterators do not publish to `chunk.mesh`, GPU state or
a host registry. The existing canonical tree leaf-profile memoization remains
metadata on the tree record; hosts that require isolated input objects should
include their own tree records in their build snapshot.

On cancellation, call `iterator.return()` and discard the task. No incomplete
mesh or incomplete validation is accepted. A host's surrounding iterator may
also own scratch storage and release it in `finally`; closing the outer iterator
is therefore important. These mesh helpers introduce no global typed-array pool
and never return a detached or transferred buffer to a pool.

Result validation preserves object and typed-array identity. Its existing
fixed, complete, independently owned ArrayBuffer requirements, cumulative buffer
limits, schema checks, collision counts, index bounds, material classes and
decoded-request binding remain enforced. The caller keeps those owned result
fields and buffers immutable until validation completes.

## Terrain candidates and geometry invariants

Generated visual summaries are available only for an internally certified
generated-v5 section view with a complete surface profile. Custom/dense or
uncertified inputs return `null` and retain the full final-state traversal.
Supply the immutable build's `finalDeltas` Map explicitly; the default delegates
to the source's normal final-delta getter and its normal expiration behavior.

Candidate preparation uses final overlays at the candidate and above it. It
accounts for fluid surfaces exposed below removed tops, including edits across a
section boundary. Edited decoration columns retain the complete column scan;
unchanged columns resolve the active rule, hash and pickup mask once. Enabled
shadows conservatively retain projection work. No candidate summary removes the
opaque section's tree or cactus model ownership. A proven empty visual summary
returns at entry and retains hidden-fluid block-count metadata.

Greedy groups are private and consumed in their original canonical order. Numeric
face keys replace tuple strings; deleting consumed cells replaces the second
visited Map/Set grid. No mesh is subdivided to force a different greedy topology.
Terrain sizes 1 through 64 keep their existing contract, including widths
31/32/33/64. Numeric ordering and row Sets do not use a truncated 32-bit width
mask.

Packed terrain vertices retain the 20-byte stride, fourth position component
containing the actual scale, originY, fractional micro-model positions, UVs,
normals, material and flags. Bounds choose the same legal scale before direct
scalar packing. Building packing retains its existing scale of 1 and light flags;
it does not replace the terrain packing format.

## Work units and indivisible operations

Work units represent bounded loop items, such as cells, candidates, ray steps,
vertices, indices or collision words. They are not milliseconds or a guaranteed
browser deadline. Canonical small models and a face's immediate neighbor work
remain individual units. The host must also budget snapshot, lighting, upload
and commit stages outside these helpers.

Terrain scans, edited column tops, large candidate ordering, greedy expansion,
models, details, shadows and vertex/index serialization can yield. Candidate
sets above 256 entries use cooperative merge ordering. Smaller native sorts
remain bounded by 256 entries.

Building work yields through voxel transforms/grouping, skylight columns and
bucket propagation, Gaussian face samples and individual light-ray voxels,
greedy groups, writer growth/final byte copies and index emission. Chunk sorting
above 256 entries is cooperative. Result creation also slices summary mapping:
offset 256-wide placements can occupy 289 default chunks, and supported smaller
chunk sizes can produce many more chunks.

Native string/base64 decode, NCM3 encode and command-envelope validation retain
their existing limits of 65,535 payload bytes and 4,096 commands, with yields
between parser envelope stages. Allocating a typed array is also indivisible.
The iterators cannot preempt JavaScript compilation or garbage collection.
Voxel painting, expanded-operation enumeration, light rays, collision scans and
large index validation are not left inside these native envelope stages. All
existing operation, voxel and material safety checks remain intact.

## Verification

The focused tests cover candidate versus complete traversal with full packed
attribute/index comparisons; final edits, fluid caps/removal/reopening, pickup
masks, negative boundaries, cross-section models and widths 1/16/31/32/33/64;
packed scale/origin/range behavior; bounded iterator reads; cancellation;
interleaved independent output; overwrite order; sparse fallback rays; and late
malicious result rejection without copying owned buffers. Existing deterministic
building renderer hashes, light/collision tests and schema/binding tests also
apply to the synchronous drains.

Performance measurements are fixture-specific. Cooperative scheduling has a
cost in very cheap cases, so allocation reductions or warmed heavy-case gains
must not be reported as universal CPU, cold-start, GPU or frame-rate gains.
