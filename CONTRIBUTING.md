# Contributing to Chunk.js

Thank you for helping improve Chunk.js. The project is in active pre-release development for NiceChunk. The package is currently marked `private: true` and is not published to npm, so a checkout of this repository is the supported development form.

## Prerequisites

- Node.js 20 or newer and the npm version bundled with it.
- A browser with WebGL2 and native JavaScript module support for browser-facing changes.
- A local HTTP server. Browser demos use native ESM and module workers and will not work correctly from a `file://` URL.

## Set up a checkout

```sh
git clone https://github.com/nicechunk/chunk.js.git
cd chunk.js
npm run check
```

The current source-only package has no runtime or development dependencies. npm is used only to invoke scripts, so no install step or lockfile is required.

To inspect a browser demo, serve the repository root over HTTP. For example, if Python is available:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8080/demo/` or another repository example. There is no application bundling step for these native ESM pages.

## Make a focused change

Before writing code, search existing issues and documentation for the behavior you intend to change. Keep pull requests small enough to review as one coherent change. Describe any effect on deterministic world generation, binary formats, worker messages, rendering passes, or public exports explicitly; those surfaces can affect saved or host-provided data.

Follow the existing module style and keep source, comments, documentation, and user-visible fallback text in English. Add or update tests next to the behavior they protect. Do not hide an integration failure by weakening assertions or silently substituting repository-local data for an authoritative host fixture.

## Test the change

Run the repository checks before opening a pull request if setup did not already complete them, and always run them again after making the change:

```sh
npm run check
```

The test commands have intentionally separate responsibilities:

- `npm test` runs every self-contained test that can execute from this standalone checkout.
- `npm run test:integration` runs host-integration tests. Those tests require the corresponding NiceChunk host checkout or explicitly supplied fixtures and are not part of the standalone CI gate.

If your change affects a browser path, also exercise it through HTTP in a WebGL2-capable browser. Include the browser name and version, operating system, tested page, and observed result in the pull request. Automated Node tests are not a substitute for a rendering or context-lifecycle check.

If you cannot run a relevant check, say which check was skipped and why. A reviewer can then determine whether additional validation is required.

## Open a pull request

A useful pull request includes:

- the problem and the intended behavior;
- the implementation approach and important alternatives considered;
- the exact commands and browser paths used for validation;
- compatibility, performance, security, and migration effects;
- screenshots or measurements when visual output or performance changes; and
- provenance and license information for any material not authored in the pull request.

Do not include credentials, production data, private chain/account data, or third-party personal information in commits, logs, screenshots, fixtures, or issues. Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.

## Licensing and provenance

Contributions accepted into this repository are provided under the repository's MIT License unless the destination file carries a different license notice. By submitting a contribution, you represent that you have the right to provide it under the applicable terms. The Contributor Covenant adaptation in `CODE_OF_CONDUCT.md` remains under CC BY 4.0. See [docs/license-status.md](docs/license-status.md) for the exact boundary around code, the embedded default avatar, governance text, NiceChunk marks, and external assets.

Do not copy or synchronize shared files into an Apache-licensed repository merely because the licenses appear compatible or the projects share maintainers. Every such transfer requires explicit authorization and a license/provenance review. Preserve applicable copyright, license, and NOTICE information, record the source revision and modifications, and obtain any additional permission required by the destination project. The same review applies when bringing files from an Apache repository into this one.

## Conduct and support

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). For usage and troubleshooting questions, see [SUPPORT.md](SUPPORT.md).
