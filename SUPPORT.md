# Support

Chunk.js is a pre-release, standalone component of NiceChunk. It is currently marked `private: true` and is not published to npm. Support is best-effort and no response or resolution time is guaranteed.

## Before asking for help

1. Read the repository README and the relevant file under `docs/`.
2. Search existing issues for the same symptom or proposal.
3. Confirm that you are using Node.js 20 or newer.
4. For browser behavior, serve the repository over HTTP or HTTPS and confirm that the browser supports WebGL2 and native ESM. Do not test a module-worker path through `file://`.
5. Run `npm test` to distinguish a standalone regression from a host-integration problem.

## Where to ask

- Use the bug report issue form for reproducible defects in this repository.
- Use the feature request form for a concrete new capability or API proposal.
- Use a pull request only when you have a focused implementation ready for review.
- Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Public issues are not appropriate for credentials, private keys, personal data, private account/chain data, unreleased host code, or exploit details.

## Information to include

Provide the smallest reproducible example and include:

- the exact commit or branch;
- Node.js, npm, browser, operating-system, and GPU details that matter;
- whether the code ran in a standalone checkout or a NiceChunk host checkout;
- the HTTP URL path used for browser tests;
- exact commands, expected behavior, actual behavior, and complete sanitized errors; and
- the origin and version of any authorized integration fixtures.

For rendering defects, a screenshot can help, but also describe the camera state, world seed or model input, and whether the WebGL context was lost or restored. For deterministic-data defects, include a minimal non-sensitive encoded input and the expected decoded or generated result.

## Support boundaries

The repository can accept reports about its own modules, documented APIs, examples, and self-contained tests. The following usually need to be handled by the owning project or service:

- NiceChunk host application setup, chain state, accounts, and deployment infrastructure;
- host-only integration tests when required fixtures or sibling repositories are absent;
- externally hosted models, textures, locale data, rules, or other assets;
- browser, driver, or GPU defects not caused by Chunk.js; and
- private forks or modified distributions.

`npm run test:integration` is intentionally a host-side lane. A failure caused solely by missing host fixtures is not a standalone installation defect; provide the authorized fixtures or reproduce the behavior through the owning host repository.

License, trademark, asset-provenance, and cross-repository synchronization questions are covered by [docs/license-status.md](docs/license-status.md). Do not solve a missing integration file by copying it from another repository without explicit authorization and license review.
