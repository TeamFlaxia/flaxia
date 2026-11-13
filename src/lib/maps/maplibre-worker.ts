// MapLibre worker entry: install the library worker first, then register the
// on-device tile protocol. Bundling both statically avoids
// `importScriptInWorkers`, which evaluates code at runtime and is blocked by
// Flaxia's CSP (`script-src` has no `unsafe-eval`).
import 'maplibre-gl/dist/maplibre-gl-worker.mjs';
import './protocol-worker.js';
