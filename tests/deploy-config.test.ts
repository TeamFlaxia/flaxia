// Deployment-config guards.
//
// `wrangler d1 migrations apply <db>` targets the LOCAL database unless
// --remote is passed, and it still reports success. A migrate:prod script
// without the flag therefore applies nothing to production: migration 0096
// (PDF attachments) shipped that way, and every PDF post on production then
// failed with a 500 because post_attachments.kind still had the pre-0096
// CHECK allowlist. No test or build step can see that, because the test
// suites run against a local database with migrations already applied — so
// the flag is asserted here instead.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const PKG_URL = new URL('../package.json', import.meta.url);
const DEPLOYMENT_DOC_URL = new URL('../docs/deployment.md', import.meta.url);
const SETUP_DOC_URL = new URL('../docs/setup.md', import.meta.url);

async function script(name: string): Promise<string> {
  const pkg = JSON.parse(await readFile(PKG_URL, 'utf8')) as { scripts: Record<string, string> };
  const value = pkg.scripts[name];
  assert.ok(value, `package.json is missing the ${name} script`);
  return value;
}

test('migrate:prod applies to the remote database', async () => {
  const value = await script('migrate:prod');
  assert.match(value, /wrangler d1 migrations apply flaxia\b/);
  assert.match(
    value,
    /--remote\b/,
    'migrate:prod must pass --remote, otherwise wrangler applies to the local database and production stays behind',
  );
});

test('migrate:local stays on the local database', async () => {
  const value = await script('migrate:local');
  assert.match(value, /wrangler d1 migrations apply flaxia\b/);
  assert.match(value, /--local\b/);
  assert.doesNotMatch(value, /--remote\b/, 'migrate:local must never touch production');
});

test('removed status worker scripts are not advertised as runnable', async () => {
  const pkg = JSON.parse(await readFile(PKG_URL, 'utf8')) as { scripts: Record<string, string> };
  for (const name of ['deploy:status', 'dev:status', 'migrate:status', 'migrate:status:local']) {
    assert.equal(pkg.scripts[name], undefined, `${name} must stay removed until the status worker is restored`);
  }
  const doc = await readFile(DEPLOYMENT_DOC_URL, 'utf8');
  assert.doesNotMatch(doc, /npm run (?:deploy|dev|migrate):status(?::local)?\b/);
});

test('deployment docs run migrate:prod and verify no migrations are pending', async () => {
  const doc = await readFile(DEPLOYMENT_DOC_URL, 'utf8');
  assert.match(doc, /npm run migrate:prod/);
  // The verification step is the whole point: applying is not the failure mode,
  // applying to the wrong database is.
  assert.match(doc, /npx wrangler d1 migrations list flaxia --remote/);
});

test('setup docs point the migration steps at the npm scripts', async () => {
  const doc = await readFile(SETUP_DOC_URL, 'utf8');
  assert.match(doc, /npm run migrate:local/);
  assert.match(doc, /npm run migrate:prod/);
  assert.doesNotMatch(
    doc,
    /pnpm migrate/,
    'AGENTS.md pins npm as the documented package manager — keep the migration steps on npm run',
  );
});

test('CSP script-src stays explicit (no unsafe-eval, no scheme allowlist)', async () => {
  const headers = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy'));
  assert.ok(csp, 'public/_headers must define a Content-Security-Policy');
  const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, 'inline scripts must be hash-authorized');
  assert.doesNotMatch(scriptSrc, /'unsafe-eval'/, 'eval-compiled scripts must not run in the app origin');
  assert.match(scriptSrc, /'sha256-[A-Za-z0-9+/]+=*'/, 'fixed inline scripts need hash sources');
  assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), 'Ruffle needs WebAssembly compilation');
  assert.ok(scriptSrc.includes('blob:'), 'game assets may load from sandboxed blob URLs');
  assert.doesNotMatch(
    scriptSrc,
    /(?:^|\s)https:(?:\s|;|$)/,
    'a bare https: scheme lets any host run scripts — allowlist hosts instead',
  );
  assert.doesNotMatch(scriptSrc, /'https'/, 'quoted schemes are invalid CSP and only add noise');
  const scriptAttr = /script-src-attr ([^;]+)/.exec(csp)?.[1];
  assert.equal(scriptAttr, "'none'", 'inline event handler attributes must be blocked');
  for (const host of ['https://cdn.jsdelivr.net', 'https://unpkg.com']) {
    assert.ok(scriptSrc.includes(host), `script-src must keep ${host} (runtime-loaded libs)`);
  }
});

test('bundles stay within budget (initial entry + total JS)', async () => {
  const assets = new URL('../dist/assets/', import.meta.url);
  let files: string[];
  try {
    files = await readdir(assets);
  } catch {
    console.log('skip: dist/ not built (run npm run build first)');
    return;
  }
  const js = files.filter((f) => f.endsWith('.js'));
  let total = 0;
  let entry = 0;
  for (const f of js) {
    const size = (await stat(new URL(f, assets))).size;
    total += size;
    if (/^main-[A-Za-z0-9_-]+\.js$/.test(f)) entry = size;
  }
  assert.ok(entry > 0, 'expected a main-* entry chunk in dist/assets');
  assert.ok(entry <= 200 * 1024, `initial entry grew past budget: ${entry} bytes`);
  assert.ok(total <= 2 * 1024 * 1024, `total client JS grew past budget: ${total} bytes`);
});

test('every env binding used in code exists in wrangler.toml (prod parity)', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const wrangler = await readFile(join(root, 'wrangler.toml'), 'utf8');
  const declared = new Set<string>();
  for (const m of wrangler.matchAll(/(?:binding|queue)\s*=\s*"([A-Z][A-Z0-9_]*)"/g)) declared.add(m[1]);
  for (const m of wrangler.matchAll(/(?:^|[\s[])name\s*=\s*"([A-Z][A-Z0-9_]*)"/gm)) declared.add(m[1]);
  for (const m of wrangler.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)) declared.add(m[1]);
  for (const m of wrangler.matchAll(/secret put ([A-Z][A-Z0-9_]*)/g)) declared.add(m[1]);

  // Test-only or gracefully-optional bindings: absent in production on purpose.
  const knownOptional = new Map<string, string>([
    ['DB_TEST', 'used only by the /api/test/reset helper'],
    ['HF_TOKEN', 'dataset export skips HuggingFace upload without it'],
    ['HF_REPO', 'dataset export skips HuggingFace upload without it'],
    ['EXPORT_BUCKET', 'dataset export artifact falls back when unset'],
    ['EXPORT_KV', 'dataset export artifact falls back when unset'],
    ['CROWD_NODE_ORIGINS', 'file-source CORS origins are optional for same-origin nodes'],
  ]);

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...(await walk(join(dir, e.name))));
      else if (e.name.endsWith('.ts')) out.push(join(dir, e.name));
    }
    return out;
  }
  const envNameConsts = new Map<string, string>();
  const used = new Map<string, Set<string>>();
  for (const f of await walk('functions')) {
    const src = await readFile(join(root, f), 'utf8');
    for (const m of src.matchAll(/export const ([A-Z][A-Z0-9_]*_ENV)\s*=\s*'([A-Z][A-Z0-9_]*)'/g)) {
      envNameConsts.set(m[1], m[2]);
    }
    const keys = new Set<string>();
    for (const m of src.matchAll(/(?:^|[^\w$.])(?:c\.env|env)\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1]);
    for (const m of src.matchAll(/env\[([A-Z][A-Z0-9_]*)\]/g)) {
      keys.add(envNameConsts.get(m[1]) ?? m[1]);
    }
    if (keys.size > 0) used.set(f, keys);
  }
  const missing: string[] = [];
  for (const [f, keys] of used) {
    for (const k of keys) {
      if (!declared.has(k) && !knownOptional.has(k)) missing.push(`${f}: ${k}`);
    }
  }
  assert.deepEqual(missing, [], 'env bindings used in code but missing from wrangler.toml');

  // DB_TEST must stay confined to the test-reset helper.
  const dbTestUsers = [...used].filter(([, keys]) => keys.has('DB_TEST')).map(([f]) => f);
  assert.deepEqual(dbTestUsers, ['functions/api/routes/tests.ts'], 'DB_TEST leaked outside the test helper');
});
