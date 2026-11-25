// Post-build steps for the adapter-cloudflare output. The adapter owns
// `.svelte-kit/cloudflare`, so anything that must ship as a static asset is
// copied there after the build finishes.

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDocsManifest } from './docs-manifest.mjs';

// adapter-cloudflare writes `_routes.json` before postbuild adds static files.
// Anything absent from `exclude` is routed to `_worker.js`, where the SvelteKit
// catch-all returns 200 text/html instead of the real file.
export function ensureStaticRouteExclusions(
  outDir,
  requiredExcludes = ['/crowd/*', '/export-popup.html', '/export-popup', '/docs/index.json', '/404.html'],
) {
  const routesFile = join(outDir, '_routes.json');
  if (!existsSync(routesFile)) throw new Error(`${routesFile} missing — is this an adapter-cloudflare output?`);
  const routes = JSON.parse(readFileSync(routesFile, 'utf-8'));
  const exclude = Array.isArray(routes.exclude) ? routes.exclude : [];
  routes.exclude = exclude;
  for (const pattern of requiredExcludes) {
    if (!exclude.includes(pattern)) exclude.push(pattern);
  }
  writeFileSync(routesFile, `${JSON.stringify(routes, null, 2)}\n`);
}

const hashBody = (body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
const inlineBodies = (file) => {
  if (!existsSync(file)) return [];
  const source = readFileSync(file, 'utf-8');
  return [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/.test(attrs) && !/application\/ld\+json/i.test(attrs))
    .map(([, , body]) => body);
};

async function main() {
  const out = '.svelte-kit/cloudflare';
  if (!existsSync(out)) throw new Error(`${out} missing — did the adapter-cloudflare build run?`);

  // The pinned Crowd node bundle is loaded with a runtime dynamic import
  // (/crowd/v<version>-0/index.js), never bundled.
  const { CROWD_NODE_VERSION } = await import('../shared/crowd-node.ts');
  const crowdSrc = 'node_modules/@flaxia/node/dist';
  if (!existsSync(crowdSrc)) throw new Error('@flaxia/node is not installed; run npm install');
  const crowdDest = join(out, `crowd/v${CROWD_NODE_VERSION}-0`);
  cpSync(crowdSrc, crowdDest, {
    recursive: true,
    filter: (src) => !/(^|[\\/])__tests__([\\/]|$)/.test(src) && !/\.d\.ts(\.map)?$/.test(src) && !/\.map$/.test(src),
  });
  console.log(`Post-build: copied Crowd node ${CROWD_NODE_VERSION} to ${crowdDest}`);

  // The export popup is a standalone HTML entry outside the SvelteKit router.
  if (existsSync('export-popup.html')) {
    copyFileSync('export-popup.html', join(out, 'export-popup.html'));
  }

  // adapter-cloudflare@8 targets Pages and its worker template drops the
  // `ctx` argument, so `event.platform` never reaches SvelteKit. The legacy API
  // needs `platform.env` (bindings) and `platform.context.waitUntil` (ActivityPub
  // delivery, background scanning). Inject both through AsyncLocalStorage so
  // concurrent requests in one isolate cannot see each other's context.
  const workerFile = join(out, '_worker.js');
  let worker = readFileSync(workerFile, 'utf-8');
  const workerPatches = [
    [
      "import { env } from 'cloudflare:workers';",
      "import { env } from 'cloudflare:workers';\nimport { AsyncLocalStorage } from 'node:async_hooks';",
    ],
    [
      'const initialized = server.init({\n\tenv,',
      'const __als = new AsyncLocalStorage();\nconst __platform = {\n\tget env() { return __als.getStore()?.env; },\n\tget context() { return __als.getStore()?.ctx; }\n};\nconst initialized = server.init({\n\tenv,',
    ],
    ['async fetch(req, env) {', 'async fetch(req, env, ctx) {'],
    [
      '\t\treturn await server.respond(req, {',
      '\t\treturn await __als.run({ env, ctx }, () => server.respond(req, {\n\t\t\tplatform: __platform,',
    ],
    [
      "\t\t\tgetClientAddress() {\n\t\t\t\treturn /** @type {string} */ (req.headers.get('cf-connecting-ip'));\n\t\t\t}\n\t\t});",
      "\t\t\tgetClientAddress() {\n\t\t\t\treturn /** @type {string} */ (req.headers.get('cf-connecting-ip'));\n\t\t\t}\n\t\t}));",
    ],
  ];
  for (const [from, to] of workerPatches) {
    if (!worker.includes(from))
      throw new Error(`adapter-cloudflare worker template changed: missing ${JSON.stringify(from)}`);
    worker = worker.replace(from, to);
  }
  writeFileSync(workerFile, worker);
  console.log('Post-build: injected platform env/context into _worker.js');

  // The docs manifest is generated after the adapter copies `public/`.
  writeDocsManifest(join(out, 'docs'));
  ensureStaticRouteExclusions(out);

  // SvelteKit owns the CSP for SSR pages (vite.config.ts `csp`), but the static
  // export popup has no nonce. Give it a hash-based policy of its own.
  const popupHashes = [...new Set(inlineBodies(join(out, 'export-popup.html')).map(hashBody))];
  const popupCsp = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "worker-src 'self' blob:",
    "connect-src 'self' https: blob: data:",
    'img-src * blob: data:',
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' https: data:",
    `script-src 'self' 'wasm-unsafe-eval' blob: ${popupHashes.join(' ')}`.trim(),
    "script-src-attr 'none'",
    "frame-ancestors 'self'",
  ].join('; ');

  const headersFile = join(out, '_headers');
  const headers = existsSync(headersFile) ? readFileSync(headersFile, 'utf-8') : '/*\n';
  const marker = '# export-popup CSP (generated by scripts/postbuild.mjs)';
  // Pages redirects /export-popup.html to the clean URL /export-popup, so the
  // policy must be attached to both paths.
  const block = `\n${marker}\n/export-popup.html\n  Content-Security-Policy: ${popupCsp}\n/export-popup\n  Content-Security-Policy: ${popupCsp}\n`;
  const withoutOld = headers.includes(marker)
    ? headers.slice(0, headers.indexOf(marker)).replace(/\n+$/, '\n')
    : headers;
  mkdirSync(out, { recursive: true });
  writeFileSync(headersFile, `${withoutOld}${block}`);
  console.log(`Post-build: wrote export-popup CSP with ${popupHashes.length} script hash(es)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
