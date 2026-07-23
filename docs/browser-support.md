# Browser Support

Chunk.js uses capability-based support rather than browser-name detection.

## Required for the core browser runtime

- WebGL2.
- Native JavaScript modules.
- Module Workers created with `{ type: "module" }`.
- Typed arrays and transferable `ArrayBuffer` objects.
- `requestAnimationFrame`, `URL`, and `import.meta.url`.

Serve the runtime from HTTP or HTTPS. `file://` is unsupported.

Some optional integrations require more:

- Web Crypto is required for blueprint SHA-256 verification.
- `fetch` is required for RPC or optional host asset loading.
- Pointer, keyboard, touch, and storage APIs are used only by the relevant controls and demos.

## Evidence, not a guarantee

On 2026-07-21, the repository was smoke-tested over local HTTP with headless Chrome 149.0.7827.53. The basic demo reached `Running`; the playable demo reached `Running` at view distance 2 and reported six module Workers. This proves that one tested environment works; it does not establish support for every Chromium version, Firefox, Safari, embedded webview, GPU, driver, or mobile device.

No automatic cross-browser matrix currently ships with the repository. A release must not claim a browser as supported until the smoke procedure below has been recorded for that browser and relevant device class.

## WebGL2 detection

Use `detectWebGl2Support()` or inspect the `supported` result from `createChunkEngine()`. A successful context creation is necessary but not sufficient for sustained rendering: drivers can still lose a context or fail under memory pressure.

Do not replace a WebGL2 failure with silent WebGL1 behavior. Chunk.js has no WebGL1 renderer.

## Module Worker fallback

Lower-level chunk code can run without Workers when configured to do so, but this is a performance fallback, not a compatibility promise for the high-level demos. Content Security Policy, incorrect MIME types, cross-origin module URLs, and static-server rewrites can all block Worker startup even when the browser implements module Workers.

Worker failures should be visible in status or diagnostic output. See [Worker protocol](worker-protocol.md) and [Troubleshooting](troubleshooting.md).

## Mobile expectations

The renderer clamps device-pixel ratio and limits uploads, view distance, particles, and other work through runtime budgets. Those defaults reduce cost; they do not guarantee a target frame rate on every phone.

Test at least:

- initial load and Worker creation;
- camera and touch controls;
- context loss and recovery where the browser exposes a test path;
- background/foreground transitions;
- sustained movement through new chunks;
- teardown and re-entry without retained Workers;
- memory pressure at the intended view distance.

Record hardware, OS, browser build, DPR, view distance, and observed metrics with any compatibility claim.

## Manual smoke procedure

1. Run `npm run check` with Node 20 or newer.
2. serve the repository root over HTTP;
3. open `/demo/` and confirm it reaches `Running`;
4. open `/demo/playable/?view=2` and confirm terrain, water, avatar, and input render;
5. inspect the console and network panel for module or Worker errors;
6. move across chunk boundaries and watch queue, draw-call, and memory statistics;
7. tear down or close the view and verify Worker activity stops.

Treat this procedure as smoke evidence only. It does not replace automated tests, accessibility review, GPU profiling, or production-host integration tests.
