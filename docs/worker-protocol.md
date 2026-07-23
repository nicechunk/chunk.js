# Worker Protocol

Chunk.js uses browser module Workers for chunk generation/meshing and optionally for building meshing. This protocol is internal and pre-1.0, but its ownership and parity rules are integration contracts.

## Delivery requirements

Workers are constructed from `new URL(..., import.meta.url)` with `{ type: "module" }`. The page, Worker module, and dependencies must be served over HTTP(S) with valid JavaScript MIME types and compatible same-origin/CSP policy.

`file://`, an HTML fallback for `.js`, or a blocked `worker-src` directive can prevent startup.

## Chunk Worker lifecycle

`ChunkManager` owns its chunk Workers.

1. The manager creates a bounded Worker pool.
2. It sends the current compiled surface-decoration rules and their revision.
3. It queues and prioritizes chunk build/remesh tasks.
4. An idle Worker receives one task and transferable packed deltas.
5. The manager validates the response against its in-flight task and chunk version.
6. Failed tasks are recorded and retried with bounded backoff where applicable.
7. A failed Worker is detached and may be replaced; repeated pool failure disables Worker mode.
8. `ChunkManager.dispose()` terminates every Worker and clears queued/in-flight/completed state.

The high-level engine owns its manager, so `engine.destroy()` must reach this disposal boundary.

## Chunk build request

The current request contains these conceptual fields:

| Field | Purpose |
| --- | --- |
| `type`, `taskId` | message routing and in-flight identity |
| `worldSeed` | deterministic world input |
| `chunkX`, `chunkZ` | integer target chunk |
| `generationVersion`, `resourceRuleVersion` | fail-closed protocol versions |
| `materialVersion` | render/material invalidation |
| `options` | size, height, minY, sea level, and terrain bounds |
| `mode`, `taskVersion` | initial build vs remesh and stale-result protection |
| `finalDeltas` | packed effective deltas for the target chunk |
| `neighborDeltas` | packed boundary deltas required for culling |
| `treeDeltas` | nearby edits that can affect tree volume |

Packed delta arrays use `Int32Array`. X/Z must already fit signed 32-bit, Y signed 16-bit, and block IDs unsigned 16-bit before packing; the sender rejects an out-of-range value rather than allowing typed-array wrapping. One payload contains at most `262144` entries. A known larger collection is rejected before typed-array allocation, while an unknown-size iterable is consumed only through that bound. The implementation may transfer the backing buffers.

## Chunk build response

A successful response includes task/chunk/version identity, optional base profile and tree instances, opaque mesh, visual mesh or visual error, timing data, and the applied rule/material versions. Identity is exact rather than advisory: `taskId` must still be in flight, the sending Worker must own that task, coordinates must match, and echoed mode/task/material versions must match the dispatched task.

The base profile/tree data may be omitted for a remesh when the manager already owns them. Mesh vertex and index buffers are transferred back to the main thread.

Each task starts in the chunk phase, where only `chunkBuilt` or `chunkBuildError` is valid. A `chunkBuilt` response with `visualPending: true` advances that same owned task to the visual phase, where only `visualBuilt` or `visualBuildError` is valid. A response with the wrong owner, coordinates, phase, type, or echoed identity is a protocol failure. The manager quarantines that sender and recovers only work actually owned by it; it never consumes another Worker's task or advertises the faulty Worker as idle.

Unloading a chunk marks its in-flight task canceled but retains Worker ownership until a terminal response arrives. Its payload is then discarded and the Worker can be released normally. Recently settled task IDs are remembered per Worker so a late duplicate from an old/canceled task is ignored without releasing or corrupting a newer task assigned to the same Worker. An unrecognized task ID is not treated as a harmless late response.

The manager must ignore a result that no longer matches the current chunk version. A Worker error is diagnostic data, not permission to accept incomplete authoritative state. Error responses quarantine the sender; chunk-phase errors release the exact task and transition its chunk out of `building`, while visual-phase errors preserve an already accepted opaque mesh.

## Buffer ownership

Transfer detaches the sender's `ArrayBuffer`. After `postMessage(message, transferList)`:

- the sender must not read, write, cache, or resend the transferred view;
- the receiver becomes the sole owner until another explicit transfer;
- reusable state must be copied before transfer or reconstructed;
- tests should assert detached/owned behavior where it affects lifecycle.

Do not put a buffer in the transfer list twice or transfer overlapping views as if they were independent.

## Surface-rule updates

Surface-decoration rules have their own Worker message and revision. A manager update marks affected chunks dirty and sends the normalized rules to every Worker. Production hosts inject only rules validated from the expected PDA; empty rules intentionally disable non-tree decorations.

## Failure and fallback

Worker initialization or execution can fail because of browser capability, HTTP/MIME delivery, CSP, serialization, memory pressure, or an implementation error.

Fallback rules:

- authority and version validation remain identical;
- the resolved public result schema remains identical;
- typed-array contents and coordinate semantics remain identical;
- performance may degrade, but correctness must not;
- failure must be observable rather than silently returning a partial result.

Chunk-manager retry state is bounded and must not create an infinite hot loop. A Worker build failure leaves the previous mesh in place and enters backoff; it does not run an expensive synchronous replacement in the same frame. Construction failure, `messageerror`, synchronous `postMessage()` failure, and runtime `error` all release their in-flight ownership. When Worker use becomes unavailable, queued/building states are reset and later dirty-build work uses the manager's synchronous path under its normal frame budget. The manager itself remains usable; Worker initialization failure is not engine disposal. Disposal cancels future dispatch by clearing ownership state and terminating the pool.

## Building Worker

`createBuildingMeshWorkerClient()` serializes one active building job at a time, supports priority/queueing, optional cancellation scope and `AbortSignal`, and falls back to main-thread parsing/meshing when a Worker is unavailable.

Both execution paths use the canonical NCM3 decoder. It rejects more than 4,096 commands or a declared expanded-operation budget above 262,144 before voxel materialization and meshing; the materialized map is independently capped at 131,072 unique voxels. Declaring a large 256-cubed blueprint therefore does not authorize a 256-cubed allocation.

At dispatch, the client snapshots only construction fields, trims and bounds the NCM3 code, normalizes foundation aliases into the fixed foundation request schema, and limits each caller-provided building, foundation, or placement label to 1,024 characters. Arbitrary host metadata is not cloned into the Worker request or echoed through its result. The fixed request carries `requestId`, `code`, optional `buildingId` and `placementId`, normalized foundation coordinates/dimensions, rotation and offsets, the overflow flag, `chunkSize`, and `revision`.

Every response is bound to both the currently active Worker instance and the active integer `requestId`. A malformed response or an unknown/mismatched ID is a protocol failure: the client terminates that Worker and rejects the active promise instead of silently leaving it pending. Event callbacks retained by an already terminated Worker are stale and cannot settle or terminate work owned by its replacement.

Successful responses are bound to the dispatched canonical code, building/foundation/placement identity, placement transform, chunk size, and mesh revision. Request binding decodes the bounded NCM3 command envelope again, without voxelizing it a second time. It checks payload length, decoded name and size, command count, exact command-envelope content bounds, and the set of materials referenced by commands. The reported material set may be a subset of referenced materials because later commands can overwrite every voxel from an earlier material. The reported voxel count must be no greater than the command-write, declared-volume, and NCM3 voxel limits, and zero commands must agree with an empty result.

This decode-only check is not a second semantic execution of the blueprint. In particular, overlapping writes mean the envelope cannot prove the exact final voxel count or final material set. It combines request binding with strict internal consistency instead: placement and chunk voxel totals must equal the building summary, every chunk count is locally bounded, and mesh/collision totals cannot exceed the final reported voxel count. The reported `building.materials` is treated as the claimed final material set. Its opaque/visual and colliding/non-colliding classes must agree with the global block counts: a single-class set requires all or zero voxels as appropriate, while a mixed set requires at least one voxel in each reported class. The decoded command material set is not used for this classification because an earlier material may be completely overwritten. A host that needs independent semantic proof must parse and voxelize the canonical NCM3 code in its own trust boundary.

Each chunk summary now includes these count fields in addition to its existing coordinates, versions, collision data, meshes, and frustum data:

| Field | Contract |
| --- | --- |
| `voxelCount` | Number of final building voxels assigned to this chunk; all chunk values must sum to `building.voxelCount`. |
| `visualBlockCount` | Number of those voxels classified for the visual material path. `mesh.blockCount + visualBlockCount` must equal the chunk voxel count. |
| `collisionBlockCount` | Population count of `collisionMask`; collision is independent of opaque/visual rendering classification. |

`visualMesh` may legitimately be `null` while `visualBlockCount` is nonzero when every face of a visual voxel is occluded. When a visual mesh exists, its `blockCount` must equal `visualBlockCount`. Counts accumulate across chunks and are compared with the building total; a later non-empty chunk is not bounded by counts accumulated for earlier chunks.

The client validates the exact summary, chunk, collision, frustum, and mesh object shapes before resolving. Chunk count and aggregate buffer work are capped by the NCM3 voxel and placement bounds. Collision masks must have the exact word count and population, while vertex/index counts, fixed 20-byte vertex stride, index width, and every index must agree. Each typed-array view must own one complete, fixed `ArrayBuffer`; shared, partial, resizable, duplicated, or wrong-width views are protocol failures. Validation traverses the received bounded views in place and does not clone their buffers.

The Worker and fallback resolve the same normalized `{ building, placement, chunks }` summary schema through the shared result builder and validator. Consumers must not receive fewer fields merely because Worker support exists. Summary objects are mutable consumer-owned structures on both paths. The fallback reuses the mesher's typed-array buffers while copying the surrounding summary objects; the Worker path transfers those buffers. Validation does not introduce another typed-array copy.

The summary deliberately omits heavy parser-only fields such as `sourceCode`, the decoded blueprint, the local voxel map, placement `worldVoxels`, and compact-parser internals. Foundation summaries contain only normalized placement fields rather than arbitrary host metadata. Application code that needs omitted fields must parse/materialize them separately rather than depend on Worker availability.

The addition of chunk `voxelCount` and `visualBlockCount`, and the removal of parser-only/host fields from resolved summaries, is a pre-1.0 protocol migration. Sender and receiver must be deployed together; an older cached Worker that omits the new fields fails schema validation rather than being accepted as a partial result.

Disposing the client rejects active/queued work and terminates its Worker. Cancellation and disposal errors are part of the API and should not be converted into successful empty meshes.

## Protocol changes

When changing a message:

1. update sender and receiver together;
2. preserve or explicitly version field semantics;
3. update transfer ownership tests;
4. test Worker and fallback parity;
5. test stale response, Worker error, cancellation, retry, and teardown;
6. record any externally observable API change in the changelog.
