// Architecture guardrail: new Cloudflare dependencies may only appear inside
// the adapter boundary (docs/architecture/platform-neutrality.md).
//
// Existing occurrences are recorded in tests/architecture-baseline.json. The
// baseline is a ratchet: remove entries as code moves behind Ports, never add
// new ones. Regenerate it only after a deliberate, reviewed change:
//
//   UPDATE_ARCHITECTURE_BASELINE=1 node --experimental-strip-types --test tests/architecture.test.ts
//
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = new URL('./architecture-baseline.json', import.meta.url);

const SCAN_ROOTS = ['functions', 'src'] as const;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.git', 'coverage']);
const ALLOWED_PREFIXES = [
  'functions/lib/adapters/cloudflare/',
  'functions/lib/ports/',
  'functions/api/types.ts',
  'functions/api/[[route]].ts',
  'functions/queue-worker.ts',
  'src/sandbox-worker.ts',
  'mail-worker/',
  'do-worker/',
  'multiplayer-worker/',
];
const ALLOWED_SUFFIXES = ['.d.ts', '.generated.ts'];

const RULES: Array<{ id: string; pattern: RegExp }> = [
  { id: 'D1Database', pattern: /\bD1Database\b/ },
  { id: 'D1PreparedStatement', pattern: /\bD1PreparedStatement\b/ },
  { id: 'D1Result', pattern: /\bD1Result\b/ },
  { id: 'R2Bucket', pattern: /\bR2Bucket\b/ },
  { id: 'R2Object', pattern: /\bR2Object\b/ },
  { id: 'KVNamespace', pattern: /\bKVNamespace\b/ },
  { id: 'DurableObjectNamespace', pattern: /\bDurableObjectNamespace\b/ },
  { id: 'Vectorize', pattern: /\bVectorize\b/ },
  { id: 'Fetcher', pattern: /\bFetcher\b/ },
  { id: 'Queue', pattern: /\bQueue\s*</ },
  { id: 'ExecutionContext', pattern: /\bExecutionContext\b/ },
  { id: 'cloudflare-package', pattern: /@cloudflare\// },
  { id: 'c.env', pattern: /\bc\.env\b/ },
];

type ArchitectureMap = Record<string, string[]>;

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await listSourceFiles(join(dir, entry.name))));
      continue;
    }
    if (!/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) continue;
    files.push(join(dir, entry.name));
  }
  return files;
}

function relativePath(absolute: string): string {
  return absolute.slice(ROOT.length).replaceAll('\\', '/');
}

function isAllowed(path: string): boolean {
  if (ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return ALLOWED_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

async function scan(): Promise<ArchitectureMap> {
  const result: ArchitectureMap = {};
  for (const root of SCAN_ROOTS) {
    for (const absolute of await listSourceFiles(join(ROOT, root))) {
      const path = relativePath(absolute);
      if (isAllowed(path)) continue;
      const source = await readFile(absolute, 'utf8');
      const matches = RULES.filter((rule) => rule.pattern.test(source)).map((rule) => rule.id);
      if (matches.length > 0) result[path] = matches.sort();
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function readBaseline(): Promise<ArchitectureMap> {
  return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as ArchitectureMap;
}

test('no new Cloudflare dependencies outside the adapter boundary', async () => {
  const current = await scan();
  if (process.env.UPDATE_ARCHITECTURE_BASELINE === '1') {
    await writeFile(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  const baseline = await readBaseline();
  const violations: string[] = [];
  for (const [file, matches] of Object.entries(current)) {
    const allowed = new Set(baseline[file] ?? []);
    const added = matches.filter((match) => !allowed.has(match));
    if (added.length > 0) violations.push(`${file}: ${added.join(', ')}`);
  }

  assert.deepEqual(
    violations,
    [],
    [
      'New Cloudflare dependencies were introduced outside the adapter boundary.',
      'Use functions/lib/ports/ and functions/lib/adapters/cloudflare/ instead.',
      'If this is intentional, update tests/architecture-baseline.json in the same reviewed change.',
      ...violations,
    ].join('\n'),
  );
});

test('architecture baseline does not contain entries that no longer match', async () => {
  const current = await scan();
  const baseline = await readBaseline();
  const stale = Object.values(baseline)
    .flat()
    .filter((match) => !RULES.some((rule) => rule.id === match));
  assert.deepEqual(stale, [], 'tests/architecture-baseline.json references unknown rule ids');
  const orphaned = Object.keys(baseline).filter((file) => !(file in current));
  assert.deepEqual(
    orphaned,
    [],
    'These files no longer have violations. Remove them from tests/architecture-baseline.json so the ratchet tightens.',
  );
});
