# Getting Started

This guide runs Chunk.js directly from a clone. The repository uses native JavaScript modules and does not require a bundle for its included demos.

## Prerequisites

- Git.
- Node.js 20 or newer and its bundled npm.
- A current browser with WebGL2, native ESM, and module Worker support.
- A local HTTP server. Python 3 is used below only as a convenient example.

The package is currently `private: true` and is not published to npm. Use a clone, workspace, or explicit file dependency; do not assume `npm install @nicechunk/chunk-js` resolves from the public registry.

The current source-only package has no runtime or development dependencies. npm is used only as a script runner, so a clean clone does not need an install step or lockfile.

## Install and check

```bash
git clone https://github.com/nicechunk/chunk.js.git
cd chunk.js
npm run check
```

`npm run check` is the repository gate. Read [Testing](testing.md) for the distinction between self-contained, host-integration, and browser checks.

## Serve the repository root

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/demo/` or `http://127.0.0.1:4173/examples/basic-voxel/`.

Serving over HTTP is required. Browsers restrict `file://` module graphs and module Workers, and MIME handling varies between local-file implementations. A different static server is fine if it:

- serves the repository root rather than only a nested demo directory;
- returns JavaScript with an accepted JavaScript MIME type;
- permits same-origin loading of relative module and Worker URLs;
- does not rewrite `.js` requests to an HTML application shell.

## Create an engine

This direct-source example avoids the root barrel:

```html
<canvas id="world" width="960" height="540"></canvas>
<script type="module">
  import { createChunkEngine } from "./engine/create-chunk-engine.js";

  const engine = await createChunkEngine({
    canvas: document.querySelector("#world"),
    viewDistance: 3,
    meshBudgetMs: 6,
    onStatus: (status) => console.info(status.stage),
  });

  if (!engine.supported) {
    document.body.textContent = `WebGL2 unavailable: ${engine.support.reason ?? "unknown reason"}`;
  } else {
    engine.start();
    addEventListener("pagehide", () => engine.destroy(), { once: true });
  }
</script>
```

`destroy()` is the complete teardown boundary: it stops animation, terminates chunk Workers, and disposes renderer resources. `stop()` only pauses the frame loop and is not a substitute for teardown.

## Choose an import surface

For direct browser work inside the clone, import a specific source file or `play.js`. Avoid `src/index.js` unless the convenience of the complete API is worth loading the full graph.

For workspace or file-dependency consumers, prefer the narrow package export for the subsystem being used. The current narrow surfaces are `./engine/create`, `./play`, `./world`, `./renderer`, `./capabilities`, `./math`, `./ncm/blueprint`, and `./ncm/character`. Check the checked-out `package.json` for the exact subpaths: the package is pre-1.0, and paths not present in its `exports` map are internal.

The `.`, `./src`, and `./engine` package exports are convenience and legacy full barrels. Native ESM evaluates every re-export, so imports through those paths can fetch unrelated modules.

## Add authoritative host state

The default high-level engine shows deterministic base terrain. A production NiceChunk host normally also needs to:

1. Load chain chunk snapshots and apply confirmed deltas.
2. Apply local transaction previews as pending deltas.
3. Fetch and validate `SurfaceDecorationTable` PDA rules.
4. Inject valid surface rules with `ChunkManager.setSurfaceDecorationRules()`.
5. Keep rule versions with persisted coordinate/proof data.
6. Dispose subscriptions, Worker clients, and the engine during teardown.

Do not substitute bundled surface-decoration fixtures for the PDA in production. Trees are generated spatially; other surface decorations remain disabled until the host supplies valid rules.

## Next steps

- Read [World generation and versioning](world-generation-and-versioning.md) before persisting world data.
- Read [Trust boundaries](trust-boundaries.md) before handling PDA, blueprint, avatar, or Forge data.
- Read [Renderer lifecycle](renderer-lifecycle.md) before adding long-lived views or context recovery.
- Use [Troubleshooting](troubleshooting.md) for Worker, MIME, WebGL2, and missing host-resource failures.
