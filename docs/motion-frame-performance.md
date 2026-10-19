# Motion frame work

The motion follow-up keeps the streaming and quality policy from 0.1.89.

## Admit a render frame before preparing visibility

Hosts can call `renderer.canPrepareFrame()` before doing render-only work. It
polls completion with timeout zero and does not consume GL errors, publish
partial uploads, or wait. When false, continue controls, physics, authority,
animation state and UI updates; retain the submitted canvas and report a
deferred frame. Do not submit an empty scene if readiness changes later in the
callback. `prepareChunksForRender()` remains responsible for atomic validation.

This keeps the existing two-frame bound. It does not manufacture FPS samples
for callbacks that did not submit a new frame.

## Committed bounds and stable order

Managed section commits publish their world AABB with the mesh revision;
column summaries publish the union, including resource extents and vertical
origins. Rejected results never replace these bounds. A pending remesh retains
the previous committed bounds. Explicit host `renderBounds` keep precedence.
Managed geometry is immutable between commits. Legacy unmanaged/mutable meshes
retain the defensive value/identity bounds path.

A camera frustum is shared while all projection inputs match. Cached rejection
planes are only hints: every changed view still tests the current planes.
Column priority order is reused within the same camera-center/load-direction
state. Public Map membership, same-size replacement and coordinate changes
invalidate that order. Per-frame frustum tests and linger state remain live.

## Avatar storage and animation

Each entity retains its own Float32 pose array through a WeakMap. Mesh sharing
does not share pose storage. A new pose increments its upload revision, and
opaque/transparent passes use the same frame snapshot. GPU handles compare both
snapshot identity and revision so array reuse cannot freeze an animation.

Static box faces and local rotations are cached with dimension/rotation
invalidation. Normals are transformed once per face and trigonometry once per
part. Position transforms preserve the existing Z/X/Y operation order and double
precision until the final Float32 store. NCM4, cloth and forged geometry retain
their existing motion paths. Transparent triangle predicates and depth ordering
are preserved without allocating triangle-index arrays for opaque triangles.

## Background uploads

`prepareChunksForRender(..., { allowBackgroundUploads: false })` admits visible
gaps but postpones speculative off-camera residency. The default is true for
existing hosts. Game sets it false during active player motion; CPU generation
and current-view uploads continue. Idle residency resumes under the existing
byte/CPU limits, 32 MiB admission threshold and validation fences.

Software browser replay and CPU microbenchmarks isolate this work. They cannot
establish hardware GPU FPS or authenticated gameplay loading performance.
