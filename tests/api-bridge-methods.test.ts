// SvelteKit rejects any HTTP method not exported from a +server.ts with 405
// before the bridged legacy handler can ever see the request. The crowd
// scan-file bridge shipped POST-only, so a signed Crowd ticket could never
// download the file; the cc-range bridge omitted OPTIONS, so cross-origin
// nodes sending a `Range` header failed preflight. Both passed CI because no
// test asserted the exported method set.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROUTES_DIR = new URL('../src/routes/', import.meta.url);
const SSR_URL = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';
const HTTP_METHOD = /\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

async function serverModules(dir: URL): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const modules: URL[] = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      modules.push(...(await serverModules(child)));
    } else if (entry.name === '+server.ts') {
      modules.push(child);
    }
  }
  return modules;
}

async function exportedMethods(module: URL): Promise<Set<string>> {
  const source = await readFile(module, 'utf8');
  return new Set([...source.matchAll(HTTP_METHOD)].map((match) => match[1]!));
}

async function methodsFor(route: string): Promise<Set<string>> {
  return exportedMethods(new URL(`../src/routes/${route}`, import.meta.url));
}

test('every +server.ts bridge exports at least one HTTP method', async () => {
  const modules = await serverModules(ROUTES_DIR);
  assert.ok(modules.length > 0, 'expected to find src/routes/**/+server.ts files');
  for (const module of modules) {
    const name = relative(REPO_DIR, fileURLToPath(module));
    const methods = await exportedMethods(module);
    assert.ok(methods.size > 0, `${name} must export at least one HTTP method`);
  }
});

test('crowd scan-file bridge exposes GET and OPTIONS, not just POST', async () => {
  const methods = await methodsFor('api/crowd/scan-file/+server.ts');
  assert.ok(
    methods.has('GET'),
    `GET must reach the legacy scan-file handler; exported methods: ${[...methods].join(', ')}`,
  );
  assert.ok(
    methods.has('OPTIONS'),
    `OPTIONS must pass CORS preflight for signed ticket downloads; exported methods: ${[...methods].join(', ')}`,
  );
});

test('crowd cc-range bridge exposes GET, POST and OPTIONS', async () => {
  const methods = await methodsFor('api/crowd/cc-range/+server.ts');
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    assert.ok(methods.has(method), `cc-range must export ${method}; exported methods: ${[...methods].join(', ')}`);
  }
});

test('live SSR server answers cc-range CORS preflight with 204', async () => {
  const response = await fetch(new URL('/api/crowd/cc-range', SSR_URL), {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://node.example',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'range',
    },
  });
  assert.equal(response.status, 204, 'OPTIONS /api/crowd/cc-range must be handled by the legacy CORS branch');
  assert.ok(response.headers.get('access-control-allow-origin'), 'preflight must allow the requesting origin');
  assert.match(
    (response.headers.get('access-control-allow-headers') ?? '').toLowerCase(),
    /\brange\b/,
    'preflight must allow the custom Range header used by Crowd nodes',
  );
});

test('live SSR server does not reject GET /api/crowd/scan-file with 405', async () => {
  const response = await fetch(new URL('/api/crowd/scan-file', SSR_URL));
  assert.notEqual(
    response.status,
    405,
    'GET must reach the legacy handler (400/401/404 is fine) instead of being rejected by SvelteKit',
  );
});
