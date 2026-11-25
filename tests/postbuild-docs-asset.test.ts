// docs/index.json is generated in postbuild, after adapter-cloudflare froze the
// worker's static asset list. SSR's event.fetch() goes through the worker (not
// _routes.json exclusions), so the manifest must be in the inlined assets Set.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDocsAssetInWorker } from '../scripts/postbuild.mjs';

function fixture(t: { after: (fn: () => void) => void }, worker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-docs-asset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '_worker.js'), worker);
  return dir;
}

test('postbuild adds the generated docs manifest to the worker asset set', async (t) => {
  const dir = fixture(t, 'const assets = new Set(["ads.txt","favicon.ico"]);\n');
  assert.equal(ensureDocsAssetInWorker(dir), true);
  assert.match(
    readFileSync(join(dir, '_worker.js'), 'utf8'),
    /const assets = new Set\(\["docs\/index\.json","ads\.txt"/,
  );
});

test('adding the docs asset is idempotent', async (t) => {
  const dir = fixture(t, 'const assets = new Set(["docs/index.json","ads.txt"]);\n');
  assert.equal(ensureDocsAssetInWorker(dir), false);
  assert.equal(
    readFileSync(join(dir, '_worker.js'), 'utf8'),
    'const assets = new Set(["docs/index.json","ads.txt"]);\n',
  );
});

test('a changed adapter template fails loudly instead of silently skipping SSR fetch', async (t) => {
  const dir = fixture(t, '// adapter template changed\n');
  assert.throws(() => ensureDocsAssetInWorker(dir), /adapter-cloudflare worker template changed/);
});
