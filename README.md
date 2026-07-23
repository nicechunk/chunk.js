# Chunk.js

Chunk.js is NiceChunk's native-ESM, WebGL2 voxel runtime. It contains deterministic world lookup, chunk state and meshing, a WebGL2 renderer, input and collision helpers, NCM codecs, building integration, and the Forge runtime.

This repository is pre-1.0 and is not a general-purpose voxel engine. Its package is currently marked `private: true` and is not published to npm. APIs, package subpaths, binary formats, and performance defaults may change until a stable release is declared.

## What it does

- Reconstructs the deterministic NiceChunk base world from integer coordinates.
- Merges rendered state as `pending delta > chain delta > deterministic base`.
- Builds opaque and visual chunk meshes on the CPU, normally in module Workers.
- Renders terrain, water, decorations, avatars, buildings, sky, shadows, and effects with WebGL2.
- Encodes and decodes NiceChunk NCM3, NCM4, and NCF1 data.

Chunk.js does not decide chain truth, transaction validity, mining permission, custody, or resource-rule governance. Host applications must supply those responsibilities and must treat renderer output as a view, not as proof.

## Requirements

- Node.js 20 or newer for repository checks and tests.
- A browser with WebGL2, native JavaScript modules, and module Worker support for interactive demos.
- An HTTP or HTTPS origin. `file://` is not supported because the runtime uses ESM and module Workers.
- A static file server; there is no application build step for the direct browser demos.

The current package has no runtime or development dependencies. npm is used only to invoke repository scripts, so no install step or lockfile is required for this source-only checkout.

The current browser evidence is intentionally narrow: the demos have been smoke-tested in headless Chrome 149. That is not a browser compatibility guarantee. See [Browser support](docs/browser-support.md).

## Run from a clone

```bash
git clone https://github.com/nicechunk/chunk.js.git
cd chunk.js
npm run check
python3 -m http.server 4173 --bind 127.0.0.1
```

Then open one of these local routes:

- `http://127.0.0.1:4173/demo/`
- `http://127.0.0.1:4173/demo/playable/?view=2`
- `http://127.0.0.1:4173/examples/basic-voxel/`
- `http://127.0.0.1:4173/debug/`

Any static server that preserves JavaScript MIME types and serves the repository root is suitable. Do not serve only the nested demo directory; relative module imports and Worker URLs resolve from the repository tree.

## Minimal browser integration

When working directly from this repository, import the narrow source module you need instead of the root barrel:

```js
import { createChunkEngine } from "./engine/create-chunk-engine.js";

const canvas = document.querySelector("canvas");
const engine = await createChunkEngine({
  canvas,
  viewDistance: 3,
  meshBudgetMs: 6,
});

if (!engine.supported) {
  throw new Error(engine.support.reason || "WebGL2 is unavailable");
}

engine.start();
window.addEventListener("pagehide", () => engine.destroy(), { once: true });
```

`destroy()` stops animation, terminates the `ChunkManager` Workers, and disposes renderer resources. Consumers should call it when an engine instance is no longer used; repeated cleanup calls are safe.

Package consumers should prefer narrow exports such as `@nicechunk/chunk-js/engine/create`, `@nicechunk/chunk-js/play`, `@nicechunk/chunk-js/world`, and `@nicechunk/chunk-js/renderer` when consuming the package from a workspace or file dependency. The `.`, `./src`, and `./engine` exports are convenience and legacy full barrels; native browser ESM must fetch and evaluate their complete dependency graph. The authoritative list of available subpaths is always the `exports` map in `package.json`.

See [Getting started](docs/getting-started.md) and the [API guide](docs/api.md) for lower-level integration.

## World and host contracts

The release contract supports generation version `5` and resource-rule version `1` only. Unknown versions must fail closed rather than silently reuse another algorithm. Persist both versions with any coordinate or proof data that must be reconstructed later. Details are in [World generation and versioning](docs/world-generation-and-versioning.md).

Non-tree surface decorations are host-governed. Production hosts must fetch and validate `SurfaceDecorationTable` PDA rules and inject them into `ChunkManager`. Until valid rules are available, those decorations remain disabled. The bundled rule list is a test and initialization fixture, not production authority.

The optional smelting-material debug page expects host files at `/rules/smelting-rules.json` and `/play/locales/en.json`. Those files are not part of this standalone repository. See [Trust boundaries](docs/trust-boundaries.md) and [Troubleshooting](docs/troubleshooting.md).

## Checks

```bash
npm test
npm run check
```

`npm test` is the self-contained repository gate. Host-coupled tests belong to `npm run test:integration` and require resources from the wider NiceChunk workspace. Browser smoke testing is a separate capability check. See [Testing](docs/testing.md) before interpreting a green test run as browser or host-integration coverage.

Run the building mesher benchmark from the repository root with:

```bash
node --expose-gc benchmarks/building-mesher.mjs 5
```

Benchmark numbers are meaningful only when recorded with the Node/browser version, hardware, input, and command.

## Project map

- `core/`: integer coordinates, deterministic hashing, and render-boundary math.
- `world/`: deterministic generation and block, resource, material, and surface-rule registries.
- `chunk/`: chunk state, delta merge, Worker orchestration, and terrain/visual meshing.
- `renderer/`: WebGL2 resources and render passes.
- `input/` and `physics/`: controls, raycast, camera collision, and motion/tool collision.
- `ncm/` and `construction/`: NCM codecs, building parsing, placement, meshing, and Worker client.
- `forge/`: NCF1 codecs, workbench operations, meshing, validation, and runtime cache.
- `engine/`: high-level engine assembly.
- `demo/`, `debug/`, and `examples/`: browser entry points; they are not all production integrations.
- `tests/` and `benchmarks/`: Node tests and measurement tools.
- `docs/`: architecture, contracts, operations, and contributor documentation.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security reports follow [SECURITY.md](SECURITY.md); usage questions and bug-report guidance are in [SUPPORT.md](SUPPORT.md).

## License and marks

Repository code is licensed under the [MIT License](LICENSE). That grant does not license the NiceChunk name, logos, or other project marks, and it does not automatically cover host-provided or third-party assets. The embedded default avatar shipped in this repository is included in the repository's MIT scope; externally loaded models and other host resources retain their own terms.

Some source files may also be shared with NiceChunk repositories under Apache-2.0. Copying or synchronizing such files across repositories requires a separate authorization and license review. See [License status](docs/license-status.md).
