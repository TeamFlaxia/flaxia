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
import { readFile } from 'node:fs/promises';
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

test('status worker migration scripts keep their explicit target', async () => {
  assert.match(await script('migrate:status'), /--remote\b/);
  assert.match(await script('migrate:status:local'), /--local\b/);
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
