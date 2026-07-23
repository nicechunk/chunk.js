# Troubleshooting

Start with the first failing boundary: HTTP delivery, module loading, Worker startup, world/state input, or WebGL rendering.

## A page is blank or modules fail to load

Check the browser console and network panel.

- Do not open the HTML with `file://`.
- Serve the repository root, not only `demo/` or `examples/`.
- Ensure `.js` responses use a JavaScript MIME type.
- Disable application-shell rewrites for module, Worker, JSON, and model paths.
- Confirm relative imports return JavaScript rather than a 404 HTML page.

The quickest known-good local command is:

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

## `WebGL2 is not available`

Chunk.js has no WebGL1 fallback. Check browser/driver WebGL2 support, hardware acceleration policy, remote-desktop restrictions, GPU blocklists, and whether another context exhausted device resources.

Use `detectWebGl2Support()` for a capability result. Do not report a browser as supported based only on its name or version.

## A module Worker does not start

Common causes are:

- `file://` delivery;
- an incorrect JavaScript MIME type;
- cross-origin Worker or dependency URLs;
- Content Security Policy blocking `worker-src` or module dependencies;
- an HTML fallback returned for the Worker module;
- a server that omits a dependency from the deployed tree.

Inspect the Worker URL and its imported modules directly. A main-thread fallback can preserve function but may change frame time; it must not change the resolved data schema.

## Workers remain after leaving a view

Call the owning lifecycle boundary, not only `stop()`:

```js
engine.destroy();
```

For lower-level ownership, call `ChunkManager.dispose()` and dispose any building Worker client. The high-level `destroy()` terminates owned chunk Workers and disposes the renderer. For older commits, inspect the implementation before relying on that behavior.

## Terrain appears but grass or flowers do not

This is the safe default when no valid `SurfaceDecorationTable` PDA rules have been injected. Trees use deterministic spatial generation; other natural surface decorations are host-governed.

Production code must fetch, validate, and inject PDA rules with `ChunkManager.setSurfaceDecorationRules()`. Do not enable the bundled default rule fixture as a silent production fallback.

## The smelting-material debug page returns 404

`debug/smelting-materials/` expects host resources at:

- `/rules/smelting-rules.json`
- `/play/locales/en.json`

They are not included in the standalone repository. Run that page from the wider NiceChunk host or supply reviewed fixtures at the same origin. The core renderer demos do not require them.

## An integration test cannot resolve a declared host file

Those tests belong to the host-integration group. Run:

```bash
npm run test:integration
```

from the expected wider workspace, or restore each file reported from `tests/host-integration/manifest.json`. Manifest host paths such as `../src` and `../forging` are resolved from the Chunk.js repository root, so the repository must be a direct child of the expected host workspace. `npm test` is the isolated repository gate and must not rely on files above the repository root.

## Importing one helper loads many modules

The root export and compatibility `src/index.js` are broad barrels. Native ESM fetches and evaluates their complete re-export graph. Prefer a scoped package export, `play.js`, or a specific source module for direct-repository development.

## World data changes or an unsupported version is rejected

Persisted world/proof input must carry its generation and resource-rule versions. The release contract accepts generation `5` and resource rule `1` only and rejects unknown values. Do not coerce an unsupported version to the current one.

At external proof boundaries, use a 32-byte or 64-hex seed. Arbitrary text seed normalization is a development convenience and may not match another implementation's seed contract.

## A blueprint is decoded but not verified

Raw NCM2/NCM3 text can be decoded for early experiments and may be returned with `verified: false`. Production blueprint authority requires the expected account envelope, payload hash, owner/address checks performed by the host, and canonical format validation. Decoding is not authorization.

## A Forge code parses but is rejected by runtime restore

Parsing and canonical acceptance are distinct. A general decode may normalize a valid non-canonical encoding, while runtime identity/cache paths may require canonical bytes. Use the strict option at trust boundaries and do not hash a normalized design as if it proved the original bytes.

## Rendering fails after context restoration

Capture the browser/GPU version and which resource class disappeared. Context restoration must rebuild programs, textures, terrain/visual buffers, avatar buffers, and auxiliary passes from CPU-owned data. Add a regression test before treating a local re-upload workaround as complete.

## Useful diagnostic report

Include:

- commit and route;
- Node version for checks;
- browser, OS, GPU, driver, and DPR;
- HTTP server and response status/MIME for the failing module or Worker;
- view distance and relevant renderer options;
- console error and the first failed network request;
- whether the issue reproduces with `/demo/?view=2` or `/demo/playable/?view=2`;
- whether teardown stops Workers;
- whether host PDA/rule data was available.

Remove wallet secrets, RPC credentials, session keys, private account data, and unredacted tokens before attaching diagnostics.
