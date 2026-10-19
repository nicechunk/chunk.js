# Bounded terrain and resource streaming

The renderer keeps CPU geometry, GPU residency and draw visibility separate.
Fog and shadows remain disabled by the Game preset. Resolution, view distance,
clouds, detailed water and material semantics are unchanged.

## Resource revisions

Ground decorations belong to the section containing their support voxel. Rule
changes compare the old/new surface groups and invalidate the relevant generated
support sections, plus sections containing edited cave supports. Pickups use the
same path for their changed columns. Dense/custom data conservatively refreshes
all visual sections. Neither operation changes opaque terrain/tree revisions.

Each section has an independent decoration revision in its Worker acceptance
stamp. At most four dirty sections share a column snapshot and Worker message.
Each child result is checked independently; an obsolete child cannot block or
replace a current sibling. Old valid GPU resources remain until a validated new
channel is committed. Synchronous and legacy single-section callers remain valid.

## GPU residency

Managed mesh commits publish an active-section list. The renderer observes a
commit once, retires channels that became empty, and adds changed nonempty
channels to its pending queue. Legacy mutable meshes retain a full recheck path.

Visible gaps get priority. The optional `residencyChunks` input permits uploads
outside the current camera frustum without adding those meshes to the draw list.
Background admission defaults to at most two channels per 100 ms, only when no
rendered frames remain in flight. Its 32 MiB application buffer threshold cannot
prevent uploads needed by the actual visible view. The existing upload CPU/byte
budgets, asynchronous validation and two-frame queue bound still apply.

Cache keys include source identity, commit/context generations and camera state.
Bounds caches follow committed mesh identities/revisions and explicit bounds.
Prepared active visibility can be reused by the immediately following render.
GPU loss discards residency observations; restoration requeues the live geometry.
Pruning releases pending sources even when they never reached a GPU allocation.

## Reusable meshes

Only complete generated builds dispatched with clean local/halo inputs qualify.
Any later voxel/neighbor invalidation makes that version ineligible. Rule/pickup
changes retain eligibility only after their current visual replacements finish.
An evicted clean mesh can be reused only with matching materials, rule signature,
pickup mask and a clean current neighborhood. Restoring creates new chunk/section
instances and commit tokens, and runs under the normal main-thread rebuild budget.
Authority snapshots still apply normally; cached presentation authorizes nothing.

The cache defaults to 32 MiB of array bytes plus conservative metadata estimates,
with a separate limit of 768 entries. Taking an entry removes its retained-byte
charge. Returning identities awaiting budgeted rehydration take eviction priority
over newly evicted unrelated terrain. A zero byte limit disables retention. Disposal clears it. This accounting
is an application limit, not a claim about the JS engine's physical heap size.

## Other hot paths

Worker voxel scratch arrays are reused with a 128 KiB retention cap and released
in `finally`. Bounds reduction uses scalar accumulators. Queue ordering refreshes
on changed priorities and periodically for age, rather than every Worker reply.
GL methods that do not track allocations bind directly to the native context;
allocation/error diagnostics remain enabled. Draw passes skip handles with no
eligible material range before changing uniforms/VAOs.

These changes do not implement shared region GPU arenas or resource instancing.
Those remain separate architectural work requiring their own geometry, memory,
transparency and context-recovery validation.
