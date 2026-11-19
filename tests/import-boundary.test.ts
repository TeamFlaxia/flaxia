// Import-boundary guardrail: Pages Functions must not import browser code
// from src/. Server and client code sharing types or helpers must go through
// shared/ (docs/architecture/platform-neutrality.md).
//
// Existing occurrences are recorded in tests/import-boundary-baseline.json.
// The baseline is a ratchet: remove entries as modules move to shared/, never
// add new ones. Regenerate it only after a deliberate, reviewed change:
//
//   UPDATE_IMPORT_BOUNDARY_BASELINE=1 node --experimental-strip-types --test tests/import-boundary.test.ts
//
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = new URL('./import-boundary-baseline.json', import.meta.url);

const SERVER_ROOT = 'functions';
const CLIENT_ROOT = 'src';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.git', 'coverage']);
const SKIP_SUFFIXES = ['.d.ts', '.generated.ts'];

// `from '...'` covers static imports and re-exports; the call forms cover
// dynamic import() and require().
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

type BoundaryMap = Record<string, string[]>;

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await listSourceFiles(resolve(dir, entry.name))));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    files.push(resolve(dir, entry.name));
  }
  return files;
}

function repoPath(absolute: string): string {
  return relative(ROOT, absolute).replaceAll('\\', '/');
}

function stripExtension(path: string): string {
  return path.replace(/\.(?:js|jsx|ts|tsx)$/, '');
}

async function clientImportsOf(absolute: string): Promise<string[]> {
  const source = await readFile(absolute, 'utf8');
  const imports = new Set<string>();
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1].split('?')[0];
    if (!specifier.startsWith('.')) continue;
    const resolved = stripExtension(resolve(dirname(absolute), specifier));
    const path = repoPath(resolved);
    if (path === CLIENT_ROOT || path.startsWith(`${CLIENT_ROOT}/`)) imports.add(path);
  }
  return [...imports].sort();
}

async function scan(): Promise<BoundaryMap> {
  const result: BoundaryMap = {};
  for (const absolute of await listSourceFiles(resolve(ROOT, SERVER_ROOT))) {
    const imports = await clientImportsOf(absolute);
    if (imports.length > 0) result[repoPath(absolute)] = imports;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function readBaseline(): Promise<BoundaryMap> {
  return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as BoundaryMap;
}

test('Pages Functions do not import browser code outside the baseline', async () => {
  const current = await scan();
  if (process.env.UPDATE_IMPORT_BOUNDARY_BASELINE === '1') {
    await writeFile(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  const baseline = await readBaseline();
  const violations: string[] = [];
  for (const [file, imports] of Object.entries(current)) {
    const allowed = new Set(baseline[file] ?? []);
    const added = imports.filter((path) => !allowed.has(path));
    if (added.length > 0) violations.push(`${file}: ${added.join(', ')}`);
  }

  assert.deepEqual(
    violations,
    [],
    [
      'Pages Functions imported browser code from src/.',
      'Move the shared module to shared/ and import it from both sides, or',
      'update tests/import-boundary-baseline.json in the same reviewed change.',
      ...violations,
    ].join('\n'),
  );
});

test('import-boundary baseline only records server -> client paths', async () => {
  const baseline = await readBaseline();
  const invalid: string[] = [];
  for (const [file, imports] of Object.entries(baseline)) {
    if (!file.startsWith('functions/')) invalid.push(`${file}: baseline key is not under functions/`);
    for (const path of imports) {
      if (path !== 'src' && !path.startsWith('src/')) invalid.push(`${file}: ${path} is not under src/`);
    }
  }
  assert.deepEqual(invalid, []);
});
