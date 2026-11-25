// docs/index.json must exist in public/ BEFORE vite build: SvelteKit's
// manifest.assets is frozen at build time and event.fetch() only serves files
// listed there (postbuild-generated files are invisible to SSR fetches).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('both builds generate the docs manifest before Vite runs', async () => {
  const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
  for (const script of ['build', 'build:native']) {
    const command = pkg.scripts[script];
    const generate = command.indexOf('node scripts/docs-manifest.mjs');
    const vite = command.indexOf('vite build');
    assert.ok(generate >= 0, `${script} must generate docs/index.json`);
    assert.ok(vite >= 0 && generate < vite, `${script} must generate the manifest before vite build`);
  }
});

test('docs-manifest CLI writes into public/docs', async () => {
  const source = await read('scripts/docs-manifest.mjs');
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/, 'CLI must be guarded so importing is side-effect free');
  assert.match(source, /writeDocsManifest\(join\(process\.cwd\(\), 'public\/docs'\)\)/);
});

test('the generated manifest is ignored by git', async () => {
  const gitignore = await read('.gitignore');
  assert.match(gitignore, /public\/docs\/index\.json/);
});
