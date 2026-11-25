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
