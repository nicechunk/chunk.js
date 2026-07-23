# Chunk.js Documentation

Chunk.js is a pre-1.0 NiceChunk-specific runtime. These documents describe the checked-out release contract. Verify `package.json`, source, tests, and the changelog when reading documentation from a different commit.

## Start here

1. [Getting started](getting-started.md) — prerequisites, local HTTP serving, and a minimal engine.
2. [Browser support](browser-support.md) — capability requirements and the limited compatibility evidence.
3. [Architecture](architecture.md) — data flow, authority boundaries, and subsystem ownership.
4. [Structure](structure.md) — directory responsibilities and dependency direction.
5. [API](api.md) — public surfaces, scoped exports, lifecycle, and error behavior.

## Runtime contracts

- [World generation and versioning](world-generation-and-versioning.md)
- [Worker protocol](worker-protocol.md)
- [Renderer lifecycle](renderer-lifecycle.md)
- [Trust boundaries](trust-boundaries.md)
- [NCM format notes](ncm-format.md)

## Verification and operations

- [Testing](testing.md)
- [Performance budget](performance-budget.md)
- [Troubleshooting](troubleshooting.md)
- [Adoption and migration plan](migration-plan.md)

## Project and legal status

- [License status](license-status.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Support](../SUPPORT.md)
- [Changelog](../CHANGELOG.md)

The source and `package.json` are authoritative when a document and a checked-out commit disagree. Documentation changes that introduce a new promise must be paired with tests or implementation evidence in the same release.
