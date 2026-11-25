// adapter-cloudflare writes `_routes.json` before postbuild adds static files
// (Crowd node bundle, export popup, docs manifest, 404.html). Without explicit
// exclusions Cloudflare Pages sends those requests to `_worker.js`, where the
// SvelteKit catch-all answers 200 text/html instead of serving the asset.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Pages serves `export-popup.html` at its clean URL `/export-popup` as well;
// that URL must bypass the worker too or the SPA catch-all shadows the popup.
const REQUIRED = ['/crowd/*', '/export-popup.html', '/export-popup', '/docs/index.json', '/404.html'];

type ExclusionsHelper = (outDir: string, requiredExcludes?: string[]) => void;

async function loadHelper(): Promise<ExclusionsHelper> {
  const mod = (await import('../scripts/postbuild.mjs')) as { ensureStaticRouteExclusions?: ExclusionsHelper };
  assert.equal(typeof mod.ensureStaticRouteExclusions, 'function', 'postbuild must export ensureStaticRouteExclusions');
  return mod.ensureStaticRouteExclusions!;
}

// `true` means the helper rewrote the worker; `false` means it skipped it.
type WorkerPatchHelper = (outDir: string) => boolean;

async function loadWorkerHelper(): Promise<WorkerPatchHelper> {
  const mod = (await import('../scripts/postbuild.mjs')) as { ensureWorkerPlatformPatch?: WorkerPatchHelper };
  assert.equal(typeof mod.ensureWorkerPlatformPatch, 'function', 'postbuild must export ensureWorkerPlatformPatch');
  return mod.ensureWorkerPlatformPatch!;
}

function workerFixture(t: { after: (fn: () => void) => void }, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-postbuild-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '_worker.js'), source);
  return dir;
}

const ADAPTER_WORKER = `import { env } from 'cloudflare:workers';
const initialized = server.init({
\tenv,
});
export default { async fetch(req, env) {
\t\treturn await server.respond(req, {
\t\t\tgetClientAddress() {
\t\t\t\treturn /** @type {string} */ (req.headers.get('cf-connecting-ip'));
\t\t\t}
\t\t});
} };
`;

// Already patched, and deliberately missing the adapter template anchors: a
// second postbuild run must skip it instead of throwing or duplicating code.
const PATCHED_WORKER = `const __als = new AsyncLocalStorage();
const __platform = { get env() { return __als.getStore()?.env; } };
export default { async fetch(req, env, ctx) {
  return await __als.run({ env, ctx }, () => server.respond(req, { platform: __platform }));
} };
`;

function fixture(t: { after: (fn: () => void) => void }, exclude: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-postbuild-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '_routes.json'), `${JSON.stringify({ version: 1, include: ['/*'], exclude }, null, 2)}\n`);
  return dir;
}

function routes(dir: string): { version: number; include: string[]; exclude: string[] } {
  return JSON.parse(readFileSync(join(dir, '_routes.json'), 'utf8')) as {
    version: number;
    include: string[];
    exclude: string[];
  };
}

test('postbuild adds every static-file route to _routes.json exclude', async (t) => {
  const dir = fixture(t, ['/assets/*', '/_app/*']);
  const ensureStaticRouteExclusions = await loadHelper();

  ensureStaticRouteExclusions(dir);

  const config = routes(dir);
  assert.deepEqual(config.include, ['/*'], 'include must stay unchanged');
  assert.deepEqual(config.exclude.slice(0, 2), ['/assets/*', '/_app/*'], 'existing excludes must be preserved');
  for (const pattern of REQUIRED) {
    assert.ok(config.exclude.includes(pattern), `missing exclude: ${pattern}`);
  }
});

test('ensureStaticRouteExclusions is idempotent and never duplicates patterns', async (t) => {
  const dir = fixture(t, ['/assets/*', ...REQUIRED]);
  const ensureStaticRouteExclusions = await loadHelper();

  ensureStaticRouteExclusions(dir);
  ensureStaticRouteExclusions(dir);

  const config = routes(dir);
  assert.deepEqual(config.exclude, ['/assets/*', ...REQUIRED]);
  for (const pattern of REQUIRED) {
    assert.equal(config.exclude.filter((value) => value === pattern).length, 1, `duplicate exclude: ${pattern}`);
  }
});

test('ensureStaticRouteExclusions accepts a custom required list', async (t) => {
  const dir = fixture(t, ['/assets/*']);
  const ensureStaticRouteExclusions = await loadHelper();

  ensureStaticRouteExclusions(dir, ['/custom.json']);

  assert.deepEqual(routes(dir).exclude, ['/assets/*', '/custom.json']);
});

test('worker platform patch is a no-op on an already-patched worker', async (t) => {
  const dir = workerFixture(t, PATCHED_WORKER);
  const workerFile = join(dir, '_worker.js');
  const before = readFileSync(workerFile, 'utf8');
  const ensureWorkerPlatformPatch = await loadWorkerHelper();

  assert.equal(ensureWorkerPlatformPatch(dir), false, 'a patched worker must not be rewritten');
  assert.equal(readFileSync(workerFile, 'utf8'), before, 'the patch must not be duplicated');
});

test('worker platform patch still applies once to an adapter-generated worker', async (t) => {
  const dir = workerFixture(t, ADAPTER_WORKER);
  const workerFile = join(dir, '_worker.js');
  const ensureWorkerPlatformPatch = await loadWorkerHelper();

  assert.equal(ensureWorkerPlatformPatch(dir), true);
  const patched = readFileSync(workerFile, 'utf8');
  assert.match(patched, /__als\.run\(\{ env, ctx \}/);
  assert.match(patched, /async fetch\(req, env, ctx\)/);
  assert.equal(ensureWorkerPlatformPatch(dir), false, 'a second run must skip the patched worker');
  assert.equal(readFileSync(workerFile, 'utf8'), patched);
});
