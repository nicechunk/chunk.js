# Shared chunk GPU storage and ordered batching

Enable `sharedChunkBuffers` on `WebGL2VoxelRenderer` to share GPU storage across
immutable terrain/visual mesh commits. The generic library default remains false;
Play enables it. `maxSharedChunkBufferBytes` defaults to 32 MiB, with an absolute
64 MiB pool ceiling. A normal page owns one VAO and three buffers: packed source
vertices, integer origin/material offsets and 32-bit rebased indices. The origin attribute uses slot 8, isolated from
avatar and particle slots 0-7, including legacy static avatar defaults.

A page starts at 32768 vertices and 65536 indices (1.125 MiB); oversized commits
may use pages up to 2 MiB. Requests beyond the pool budget, unsupported layouts,
noninteger/unrepresentable origin offsets and vertices shared across incompatible
opaque/cutout passes retain the standalone buffer path. Origins are subtracted
in JavaScript before float conversion, preserving large signed world positions.

An immutable commit leases disjoint vertex and index slices. Byte-limited uploads
include origin data and preserve the existing CPU/transfer deadlines. The old
lease remains published until upload validation succeeds. Allocation/upload
failures retain committed geometry and disable shared allocation for that
context so retries can use ordinary buffers. Released spans wait for the renderer to report no in-flight frame/upload fence,
then are coalesced and reused; reclamation never blocks. at most two empty validated pages are cached. Context loss clears pool
ownership without deleting invalid context handles; restoration creates a new pool.

Opaque/cutout pass tags permit one shader state for consecutive ranges.
Only adjacent draws using the same shared page are combined; neither chunk order
nor triangle order changes. The extension path uses `WEBGL_multi_draw`; ordinary
ordered draw calls and contiguous-range coalescing remain available without it.
Transparent units keep their logical sorting offsets and original world centers.
The sorted queue can batch across shared pages only when adjacent units use the
same page/state; avatars, particles, previews and other pages remain boundaries.

Shared origins and 32-bit indices consume extra bytes compared with separate
16-bit buffers. Diagnostics expose reserved/live shared bytes, page count and
allocation fallback; the GPU ledger counts actual page allocations once. These
are application allocation metrics, not physical VRAM or hardware frame rates.

Tests cover an independent geometry/ordered-draw oracle, disjoint byte-limited
replacement, free span reuse, budget/failure fallbacks and lost contexts. Native
software GL fixtures compare pixels at origins 0, +/-2^24 and 2^40, including local
replacement, prune/re-add, extension-disabled and zero-pool-budget paths.
