# Trust Boundaries

Chunk.js decodes, reconstructs, and renders data. Those operations do not by themselves prove account authority, transaction validity, ownership, custody, or license rights.

## Authority layers

| Data | Chunk.js responsibility | Host responsibility |
| --- | --- | --- |
| Base world | Deterministic reconstruction for supported versions | Supply canonical seed/version; compare with verifier |
| Confirmed chunk deltas | Merge and snapshot concurrency behavior | Verify program owner, PDA, layout, commitment, and freshness |
| Pending deltas | Local preview and rollback | Sign, submit, reconcile, and surface failure |
| Surface decorations | Normalize/compile injected rules and render results | Fetch and validate expected `SurfaceDecorationTable` PDA |
| Resource lookup | Map supported reconstructed block to resource registry | Enforce mining/action/account rules |
| Blueprint/building | Decode, place, mesh, and collide | Verify account envelope, hash, PDA, owner, and authorization |
| Character/Forge code | Decode, validate format bounds, and render | Establish account provenance, custody, and permitted effects |

The renderer is always downstream of authority.

## Seed, versions, and coordinates

Use a 32-byte seed or 64-hex encoding at external proof boundaries. Text seed folding is a local convenience and should not be assumed by another verifier.

The release accepts generation version `5` and resource-rule version `1` only. Unknown versions fail closed. Integer coordinates and the explicit versions belong in persisted proof/reconstruction records. Delta X/Z must fit signed 32-bit, Y signed 16-bit, and block identity unsigned 16-bit before state mutation or Worker transfer; coercion or typed-array wrapping is not an authority-preserving normalization. Derived generation coordinates use verifier-compatible saturation at those signed endpoints, including terrain warps, ore and tree hashes, and noise neighbors.

Convenience configuration is a separate boundary: `createWorldGeneratorConfig()`, `ChunkManager`, and `ChunkState` accept controlled numeric strings for supported integer settings and versions. Direct reconstruction/proof APIs do not. A host must parse and validate external records before calling them and must pass an actual numeric `options.generationVersion` to `getResourceAt()`, including when it supplies `options.blockId` directly.

`createWorldGeneratorConfig()` returns a frozen value object. Seed bytes and generation caches are private per-config state: the public seed is a detached copy, and no writable surface/terrain/water cache is exposed for authority injection. A structured clone or equivalent foreign config receives fresh private cache state lazily when reconstruction first uses it.

Camera floats, mesh buffers, colors, shader output, AO, shadows, animation, and pending deltas are not valid proof inputs.

At non-divisor development chunk sizes, endpoint profile cells may alias after signed-i32 saturation. Generation callbacks and hashes consume the saturated coordinate, while GPU/frustum placement keeps the exact affine chunk origin so representable cells are not shifted. Tree/canopy aliases are emitted once; any remaining base-terrain fringe visualization outside i32 is display-only and must never be interpreted as another authoritative coordinate. Canonical chunk size `16` has no endpoint fringe.

## Chain snapshots and pending state

Final rendered state is `pending > chain > base`, but that does not make pending state confirmed. Hosts must label it clearly, reconcile transaction outcomes, and roll back failure.

Snapshot revision/token/slot checks protect against stale RPC data. `null` is the only no-precondition sentinel for the expected revision; explicit revisions, tokens, and slots must be non-negative safe integers and are never coerced from strings or fractional/non-finite values. Chunk.js validates a complete delta batch before mutation, rejects coordinates outside the active world's build span, rejects a full snapshot containing any delta for another chunk, and fails closed at documented batch/chunk/resident-memory ceilings. These ceilings contain local work; they do not prove that input came from an authorized account. The host still verifies the account address, program owner, discriminator/layout, cluster, commitment, and application-level authorization before passing deltas to Chunk.js.

## Surface-decoration PDA

Trees are deterministic spatial world data. Other natural surface objects are governed by a PDA table.

If fetch or validation fails:

- leave non-tree surface decorations disabled;
- do not silently load bundled defaults;
- do not infer rules from rendered models or item names;
- report the unavailable authority boundary to the host.

Bundled surface rules are fixtures for initialization/tests. They are not production chain truth.

## Blueprint and building data

`decodeBlueprintAccount()` accepts a structured NCBP envelope and, for early compatibility, raw NCM2/NCM3 text. Raw text returns `verified: false`. Parsing it safely as declarative data is not the same as verifying its account.

Production hosts should verify:

- expected RPC cluster and program owner;
- expected PDA/address derivation and authority;
- NCBP layout/version and stored payload length;
- SHA-256 payload match;
- canonical NCM encoding and codec bounds;
- foundation ownership/permission and placement rules.

NCM3 is declarative and is not evaluated as executable code.

## NCM4 character data

NCM4 bounds palette, geometry, rig, action, and payload size and uses CRC32C. CRC32C detects accidental corruption; it is not a cryptographic signature and does not establish who authored or owns the character.

The host must separately verify the account or asset source. Visual animation and equipment visibility are display state, not custody proof.

## NCF1 and Forge

NCF1 parsing, canonical encoding, runtime mesh restoration, material proof, and chain effects are separate concerns.

- A general decode can normalize valid non-canonical input unless strict canonical mode is requested.
- Identity, hashes, caches, and proof paths should require canonical bytes.
- The on-chain equipment header intentionally does not trust arbitrary visual geometry.
- Display attributes are not automatically material capacity or enforced gameplay effects.
- Material proofs require their own verified capacity input.

Forge v1 `attributes.density`/`densityScore` is a bounded gameplay score, while normalized `densityKgM3` is the independent physical input for mass. A particular-smelt score overrides the recipe/base score; physical-to-score conversion is only a lower-priority compatibility fallback. Workbench `massWeight`/`massMicrograms`, `massMilligrams`, physical advisories, attribute inheritance, and the NCF1 `mass5g` value use physical density rather than the gameplay score.

A profile marked `densityKgM3Source: "archetype-fallback"` or `physicalDensityFallback: true` contains only a deterministic preview fallback. Even an input-sourced density is metadata until the host validates its account, recipe, or material authority. NCF1 encodes the resulting 5-gram mass and quantized gameplay attributes, not physical density or its provenance, so bytes alone cannot prove that the supplied kg/m3 value was legitimate.

Do not hash a normalized design and claim that hash authenticated the original non-canonical byte stream.

## Worker and renderer data

Worker messages and typed arrays are same-application data, not a security boundary. Validate versions, sizes, task identity, and result schema anyway so stale or malformed results fail safely.

Rendered pixels and GPU buffers are never authority. Picking/mining uses CPU integer reconstruction and host action validation, not framebuffer colors.

## Host files and external assets

The standalone repository does not supply every host resource. Examples include smelting-rule JSON, locale JSON, optional externally fetched avatar models, RPC responses, and PDA accounts. Validate their origin, schema, version, and license before use.

The embedded default avatar code shipped in `renderer/avatar-mesh.js` is within this repository's MIT scope. Optional fetched models and other external/host assets are not covered merely because Chunk.js can load them.

## Secrets and diagnostics

Chunk.js should not receive wallet secret keys, GitHub tokens, deployment keys, or RPC credentials that are not required for a narrow operation. Never place secrets in browser bundles, issue templates, test fixtures, screenshots, render logs, or Worker messages.

Redact account-private data and tokens before sharing console/network traces.

## License and repository boundary

Repository code is MIT-licensed. NiceChunk names, logos, and marks are not granted by the MIT license. Third-party and host assets retain their own terms.

Some runtime files may be synchronized with NiceChunk repositories under Apache-2.0. Cross-repository copying requires explicit authorization and a per-file license review; path or content identity is not sufficient evidence of dual licensing. See [License status](license-status.md).
