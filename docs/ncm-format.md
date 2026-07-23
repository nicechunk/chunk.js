# NCM Format Notes

Chunk.js supports three NiceChunk Model generations with different purposes. The codec source and tests are authoritative; this pre-1.0 overview is not a byte-by-byte frozen specification.

## NCM2

NCM2 is a legacy compatibility format used by existing voxel avatars and blueprint conversion helpers. New self-contained animated characters should use NCM4, and new declarative building blueprints should use NCM3.

Compatibility decoding does not establish asset ownership, account provenance, or a license for the decoded model.

## NCM3 blueprints

NCM3 uses the `NCM3:` prefix followed by canonical unpadded Base64URL. Its binary payload declares dimensions, materials, and bounded voxel-building commands. The decoder validates the envelope, version, dimensions, command limits, material IDs, integer bounds, and complete input consumption.

The release limits an NCM3 raw payload to 65,535 bytes. Integer fields use canonical unsigned 32-bit varints: arithmetic decoding preserves the full unsigned range, while overflow and overlong encodings are rejected. Oversized, padded, non-canonical, or malformed Base64URL input is rejected before unbounded decode work.

NCM3 is declarative. `parseNcm3Building()` decodes and voxelizes commands; it does not evaluate model text as JavaScript. Construction placement uses integer translation and quarter-turn rotation and never rescales a building to make it fit a foundation.

The exported `NCM_MATERIALS` table (and its compatibility alias `MATERIALS`) provides presentation metadata for canonical material IDs. Its `transparent` flag is true for both `fluid` and `transparent` renderer shader classes, and `opacity` is the material base-color alpha for those classes. These fields are rendering hints; they do not establish collision, placement, or chain authority by themselves.

## NCBP account envelope

An NCBP blueprint account contains a header, authority bytes, the SHA-256 digest of its stored payload, a payload length, and either raw NCM3 bytes or UTF-8 NCM code according to its flags.

`decodeBlueprintAccount()` accepts `ArrayBuffer` or `ArrayBufferView` input, checks `byteLength` before constructing a byte view, and then verifies the envelope's supported layout and payload digest. It also accepts raw NCM2/NCM3 text for early compatibility and explicitly returns `verified: false` for that path.

The host still verifies RPC cluster, program owner, expected PDA/address derivation, account authority, commitment/freshness, and application authorization. A matching payload hash is integrity evidence, not complete account authority.

## NCM4 characters

NCM4 uses the `NCM4:` prefix followed by canonical unpadded Base64URL. It is a self-contained animated character format with:

- a fixed 20-bone vocabulary;
- five defined action IDs in this release;
- bounded palette, cuboid, coordinate, group, duration, and keyframe values;
- a maximum 1,532-byte raw payload so the encoded value fits the intended 2,048-byte field;
- CRC32C corruption detection;
- canonical decode/re-encode behavior.

CRC32C is not a signature. It does not establish author, account, custody, or permission to redistribute the model.

The exported `ncm4Crc32c()` helper accepts BufferSource input up to the NCM4 payload ceiling. It rejects numbers and generic array-like objects so a caller-controlled `length` cannot trigger an allocation.

## Canonical encoding

Canonical form matters when a code is used as an identifier, hash input, cache key, or chain field. Decoders reject leading/trailing whitespace, padding, alternate case in the prefix, non-Base64URL characters, non-canonical Base64URL, trailing unread bytes, unsupported versions, and oversized input where required by the format.

Do not normalize an untrusted string and then claim the normalized code authenticates the original byte sequence.

## Changes and compatibility

Any change that alters canonical bytes, limits, command meaning, material identity, rig/action meaning, or accepted envelope versions requires:

1. new or updated golden vectors;
2. rejection tests for malformed and oversized inputs;
3. cross-implementation review with relevant host/chain consumers;
4. migration guidance for stored codes;
5. a changelog entry;
6. an explicit format-version decision when old bytes would change meaning.

See [Trust boundaries](trust-boundaries.md) for account and asset provenance, and [API](api.md) for the package codec entrypoints.
