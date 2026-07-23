# World Generation and Versioning

Deterministic world reconstruction is a protocol boundary. Version fields are not descriptive labels; they select an accepted algorithm and must be validated before reconstruction.

## Supported release versions

| Domain | Supported value |
| --- | ---: |
| World generation | `5` |
| Resource rule | `1` |

`SUPPORTED_GENERATION_VERSIONS` and `SUPPORTED_RESOURCE_RULE_VERSIONS` expose the accepted sets. Public world config, chunk state/manager, block lookup, and resource lookup reject unknown, malformed, older, newer, or negative versions.

Configuration and reconstruction boundaries are deliberately distinct. `createWorldGeneratorConfig()`, `ChunkManager`, and `ChunkState` normalize supported version and integer settings with `Number()`, so controlled numeric strings are accepted as configuration input. Direct block/chunk reconstruction and resource-proof lookups require actual integer coordinates and explicit numeric versions; numeric strings and omitted versions are rejected. Persisted or chain-derived proof data must use the strict reconstruction form rather than relying on configuration coercion.

Failing closed prevents data labeled as one version from being reconstructed with another version's algorithm. Never catch a version error and silently substitute the default.

## Reconstruction input

Persist at least:

```text
seed bytes or canonical seed encoding
generation version
resource-rule version
integer world/chunk coordinates
confirmed chain delta snapshot identity where applicable
```

For cross-language or chain input, use exactly 32 seed bytes or a 64-character hexadecimal encoding. Arbitrary text is normalized by a repository convenience function using XOR folding; it is not recommended as a new external seed protocol.

World, chunk, local, mining, and proof coordinates must be integers. Camera-relative floats and mesh vertices are derived display data.

The current transfer/proof boundary uses signed 32-bit world X/Z, signed 16-bit world Y, and unsigned 16-bit block IDs. A delta outside that domain is rejected before it reaches chunk state or an `Int32Array` Worker transfer; silently wrapping a coordinate would make main-thread and Worker reconstruction disagree. Derived generation coordinates follow the Rust verifier's saturating signed arithmetic instead of JavaScript's wider `Number` arithmetic followed by an implicit 32-bit wrap. This applies to terrain and river warps, noise-cell neighbors, coal lenses/veins, tree candidate origins, and leaf hashes at `i32::MIN` and `i32::MAX`.

For a non-canonical development chunk size that does not divide the signed-32-bit span, each endpoint chunk is still accepted. Chunk/local reconstruction first evaluates the exact affine integer `chunk * chunkSize + local`, which is safely representable as a JavaScript `Number` under the supported bounds, and then saturates the completed result to signed 32-bit range once. This preserves the inverse produced by `normalizeDelta()` at `i32::MIN` and `i32::MAX`; cells in the partially overlapping fringe can intentionally alias an endpoint. Do not use wrapping math, saturate the multiplication before adding the local coordinate, or silently discard the partial chunk. Canonical size `16` divides the signed endpoint layout exactly, so this rule produces the same coordinates as the Rust verifier's sequential saturation and has no endpoint alias.

Meshing has two deliberately different coordinate roles at those development-only endpoint chunks. Any coordinate sent back into generation, column, water, delta, decoration, or deterministic-hash logic uses the same saturated chunk/local conversion as reconstruction. Local mesh vertices, GPU chunk uniforms, visibility centers, and frustum bounds instead retain the exact affine chunk origin: clamping that one shared render origin would displace the representable endpoint cells. Tree instances and canopy cells are deduplicated by saturated world coordinate and then placed in their unique in-domain affine local cell. Base-profile fringe columns still exist as aliases and can therefore render just outside the signed-i32 domain when a non-divisor chunk size is used; this is a known development visualization limitation, not an additional world coordinate or proof input. Canonical size `16` has no such fringe.

Configuration is resource-bounded before any range loop or typed-array allocation. Chunk size is `1..64`, height is `1..4096`, materialized chunk volume is at most `4,194,304` voxels, and the configured vertical span must fit signed 16-bit Y. These are implementation safety bounds, not a declaration that every combination is performant. Record the exact configuration used by any non-canonical development world.

The generated vertical domain is the inclusive range `minY..maxBuildY`; point lookup, base lookup, materialized chunks, and compact `baseProfile` resolution return air outside it. A generated profile carries `maxBuildY`, so constructing `ChunkState` from the profile alone cannot widen that authority boundary to the allocation top. Generation v5 normally reserves one block above terrain, so its effective terrain ceiling is `min(maxTerrainHeight, maxBuildY - 1)`, clamped no lower than `minY`. A one-layer world cannot reserve headroom and uses `minY` as its bedrock surface. `seaLevel` remains an input to terrain shaping, but emitted water is clipped to `maxBuildY` and exists only when that clipped level is above the surface. This effective clipping lets small development worlds retain the supported `height` range without creating out-of-span surface or water data.

World seed bytes owned by a generator config, `ChunkManager`, or `ChunkState` are private snapshots. Their public `worldSeed` accessors return detached copies, and Worker messages receive another copy. Generator configs are frozen value objects and expose no mutable cache; terrain, surface, and water caches live in private per-object state that is created lazily for structured clones or equivalent foreign configs. Mutating a returned typed array or attempting to replace config metadata therefore cannot change cached output, make a later salt use different bytes, alter `worldSeedHex`, or split Worker and synchronous reconstruction.

## Version 5 responsibilities

Generation v5 determines the deterministic base terrain, surface blocks, water/floodplain behavior, and tree placement used by this release. The compact `baseProfile` is an optimization of that same result, not a different source of truth.

Changing constants, hash salts, coordinate conversion, noise interpolation, height/surface decisions, water decisions, or tree decisions can change v5 output. Such a change must not be shipped under version `5` if it alters an established golden result.

## Resource rule version 1

Resource-rule v1 derives the resource from the reconstructed or explicitly supplied block through the block registry. `getResourceAt()` requires the caller to pass generation v5 explicitly as `options.generationVersion`, even when `options.blockId` supplies the block and no reconstruction is needed. This keeps both validated version domains in the returned proof record.

Resource-rule versioning is separate from surface-decoration PDA governance. A decoration can have its own governed drop block while the underlying terrain resource remains a block-registry result.

## Surface decorations

Trees are deterministic multi-voxel spatial generation. All other natural surface objects must be resolved from a validated `SurfaceDecorationTable` PDA and attached to their supporting terrain face.

The production sequence is:

1. fetch the expected PDA account;
2. verify program owner, address/seed derivation, layout/version, and account freshness in the host;
3. normalize and validate rule bounds/counts;
4. inject rules into `ChunkManager`;
5. keep decorations disabled if validation or fetch fails.

Bundled default surface rules are initialization and test fixtures. Using them as production authority would cross the trust boundary.

## Adding a future version

A new generation or resource-rule version requires:

1. a protocol/design decision explaining why the old output cannot remain;
2. an implementation branch that preserves every previously supported version;
3. golden vectors shared with every verifier/SDK implementation;
4. negative tests for unsupported versions;
5. migration rules for stored coordinates, proofs, and snapshots;
6. updated host/on-chain acceptance before clients emit the new version;
7. changelog and compatibility documentation.

Do not mutate v5 in place, alias a new version to v5 without a deliberate compatibility decision, or broaden the supported set before all authorities can verify it.

## Golden vectors

A useful vector includes:

- canonical seed bytes;
- generation and resource-rule versions;
- integer coordinates;
- expected surface height, water level, block ID, and resource ID;
- tree instance data where relevant;
- expected rejection for unsupported versions.

Record vector provenance and fixture revision. A golden update is a protocol review, not routine snapshot maintenance.

The signed-endpoint fixtures in `tests/world-i32-parity.test.mjs` were emitted by compiling the authoritative Rust `state.rs` in a separate read-only probe. Their recorded source is parent revision `012c91571057fa8b244114a9fd6aba708f15fe9b`, `state.rs` SHA-256 `3883cebaaf7be7ef4d13fba06e5b85761bf654c2423bd1b51e41842440255577`, dirty diff SHA-256 `d439ed7be9e850d87cb2c401f9ffa583e1c1d0e5cd22cf9986d7c15a6dfe79c0`, compiled with `rustc 1.97.1 (8bab26f4f 2026-07-14)`. The full boundary-column signature is `bc0dba49848ef10e06034ce39d8521809aa90d32edba128918834d7166f1ac77`. It covers complete canonical columns at both signed endpoints plus targeted coal and tree/leaf cases; separate interior signatures prove that endpoint saturation did not alter established ordinary-coordinate output. Additional main-thread and Worker regressions exercise non-divisor endpoint profiles, resolvers, tree alias elimination, and visual meshing without forwarding a coordinate outside signed i32.
