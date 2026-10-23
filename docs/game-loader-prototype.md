# Local game loader prototype

This is the first compatibility experiment for a dedicated loader and Service
Worker. It is deliberately separate from public post playback: no timeline,
Arcade, or existing player chooses this path. Open `/game-loader/prototype` on
the sandbox origin and choose a local test ZIP. ZIP bytes never upload to a
server. The prototype is a developer page, not an offline public-game player.

## Running

```sh
npm ci --ignore-scripts
npm run build:game-loader
npx wrangler dev --config wrangler.sandbox.toml --port 8791
```

Open `http://localhost:8791/game-loader/prototype`. Use a small classic-script
HTML5 game without external dependencies. After starting it, reload the loader
page and click **Reopen saved game**. The status should change from cache MISS
to HIT with zero extraction time. The displayed `shellReadyMs` measures shell
initialization, not the game's first playable frame.

`npm run build` and `npm run deploy:sandbox` build the ZIP extraction worker.
The sandbox deployment workflow uses the latter so the generated asset is
available even when the main app build runs in another CI job. Generated assets
are ignored by git; no third-party CDN scripts are loaded at runtime.

## Boundaries

- The trusted loader page runs only first-party static code. It never evaluates
  uploaded scripts or installs an uploaded Service Worker. Its CSP disallows
  inline scripts and eval.
- The SW has `/game-loader/` scope. Cache RPC accepts only the exact trusted
  loader client URL, with an origin check. Its state survives worker termination
  through CacheStorage; it needs no in-memory ZIP filesystem.
- ZIP parsing/decompression runs in a disposable Web Worker. The compressed
  limit is 25 MB, the expanded limit is 100 MB, and the entry limit is 1024.
  Paths, duplicates, file types and declared sizes are checked before expansion,
  with actual sizes checked afterwards.
- Cache entries are keyed by ZIP SHA-256 and a prototype schema revision.
  Expanded files are saved first; a completion marker is written last.
  Failed writes and incomplete reads discard the archive. The prototype has a
  **Clear prototype cache** button; automatic LRU eviction is a later step.
- Uploaded files are data-only CacheStorage entries. There is no SW fetch
  handler or HTTP route that can serve them as origin-trusted HTML.
- A separate HTTP game shell has a response-header sandbox CSP and an iframe
  sandbox, both without `allow-same-origin`. It receives files through a
  MessageChannel after source/origin validation. Only this opaque context builds
  Blob URLs and executes game scripts. The shell keeps its HTTP CSP while its
  document is replaced; no meta CSP is used as a security boundary.
- The prototype game CSP blocks external resources, forms and nested frames.
  The loader does not relay game messages into account APIs.

The distinction between loader and game is required: an opaque sandboxed
document does not inherit a controlling Service Worker. See the
[Service Worker client model](https://www.w3.org/TR/service-workers/#control-and-use).

## Compatibility being tested

Static scripts, images, audio, external CSS with relative dependencies, dynamic
image `src`, `fetch`, XHR and streaming WASM compilation use Blob assets created
inside the game shell. This is a bounded compatibility adapter, not transparent
network interception. Missing files, module entry scripts, nested frames and
`srcset` report an error. Runtime-generated modules, Workers, advanced CSS,
multi-page navigation and engines such as Unity are not claimed supported.
Public games continue to use WVFS, including games incompatible with this lab.

## Tests

```sh
node --test --experimental-strip-types tests/game-loader.test.ts

# Optional browser tooling; not an application dependency.
npm install --no-save --package-lock=false --ignore-scripts playwright@1.51.1
npx playwright install chromium
npm run build:game-loader
npm run test:game-loader:browser
```

The browser test runs a local HTTP server using the actual loader routes and
CSP headers. Its fixture exercises CSS, image/canvas reads, audio metadata,
fetch, XHR and WASM. It reloads the page to discard memory state, then checks a
cache HIT with no extraction worker request and verifies that game code cannot
access parent DOM, persistent storage or SW registration. It also checks that
unsupported module games fail explicitly. This test has a separate CI job.

Set `LOADER_BROWSER=firefox` or `LOADER_BROWSER=webkit` after installing that
Playwright engine to run the same experiment there. An optional
`PLAYWRIGHT_MODULE` selects a local Playwright module path, and
`LOADER_CHROMIUM_EXECUTABLE` selects an existing browser binary.

## Before public integration

1. Establish the browser/engine compatibility matrix with representative games;
   measure first playable frame and memory on mobile, not just shell timing.
2. Add a server-authoritative public-game descriptor and versioned download
   endpoint. Validate publication and scan state at each launch before local
   cache reuse. No user-provided message may authorize a public game.
3. Make asset resolution explicit per supported engine. Add storage/capture/
   multiplayer bridge relays with source validation and game namespaces.
4. Add storage-budget/LRU management, concurrent-session pins and cache-schema
   upgrades. Handle quota/eviction and unsupported browsers through WVFS.
5. Integrate behind an opt-in feature flag. Reuse the edge cache from #241 for
   cold acquisition and fallback. Offline public playback needs a separate
   revocation policy; this prototype does not change the scan delivery rules.

Local verification: build, unit tests, lint, TypeScript 6 checking and sandbox
dry-run bundling can run in the Codex environment. Native Chromium exits at
startup in that environment; browser compatibility results must come from the
dedicated CI job or a normal local browser, not from mocked cache tests.
