// Regression guard: this repo ships through GitHub Release tarballs, not npm.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function filesUnder(dir: string): string[] {
  const full = join(ROOT, dir);
  try {
    if (!statSync(full).isDirectory()) return [full];
  } catch {
    return [];
  }
  return walk(full);
}

test('no workflow publishes to npm', () => {
  const workflowDir = join(ROOT, '.github', 'workflows');
  const files = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length > 0, '.github/workflows contains no workflow files');
  const forbidden = [/npm publish/, /NODE_AUTH_TOKEN/, /NPM_TOKEN/];
  const hits: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(workflowDir, name), 'utf8');
    for (const pattern of forbidden) {
      const match = source.match(pattern);
      if (match) hits.push(`.github/workflows/${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'npm publishing was reintroduced in CI workflows');
});

test('no package.json declares publishConfig', () => {
  const manifests = walk(ROOT).filter((file) => file.endsWith('package.json'));
  assert.ok(manifests.length > 0, 'found no package.json files');
  const offenders: string[] = [];
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (Object.hasOwn(manifest, 'publishConfig')) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], 'publishConfig must not exist; packages ship as Release tarballs');
});

test('flaxia packages are consumed from vendor tarballs', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const deps = root.dependencies ?? {};
  for (const name of ['@flaxia/node', '@flaxia/sdk', '@flaxia/mail-contract']) {
    const spec = deps[name];
    assert.ok(spec, `root package.json is missing dependency ${name}`);
    assert.ok(
      spec.startsWith('file:vendor/'),
      `${name} must resolve to a vendor tarball (file:vendor/...), got ${spec}`,
    );
  }
});

test('no runtime reference to the unpkg @flaxia CDN', () => {
  const sources = [...filesUnder('src'), ...filesUnder('functions'), ...filesUnder('vite.config.ts')].filter(
    (file) => !file.endsWith('package-lock.json'),
  );
  const offenders: string[] = [];
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    if (source.includes('unpkg.com/@flaxia')) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], 'runtime code must not load @flaxia packages from unpkg');
});
