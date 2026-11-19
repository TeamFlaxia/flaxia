// A2 completion guard: the media upload path runs on Ports, not Cloudflare
// bindings accessed through `c.env`. The route only composes the adapter.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const UPLOAD_PATH = new URL('../functions/lib/media-upload.ts', import.meta.url);
const ROUTE_PATH = new URL('../functions/api/routes/media.ts', import.meta.url);

test('media upload uses Ports and never touches c.env directly', async () => {
  const source = await readFile(UPLOAD_PATH, 'utf8');
  assert.doesNotMatch(source, /\bc\.env\b/, 'the upload path must not read bindings through c.env');
  for (const port of ['services.db', 'services.kv', 'services.blobs', 'services.tasks']) {
    assert.ok(source.includes(port), `the upload path must use the ${port} Port`);
  }
});

test('the media route composes the Cloudflare adapter', async () => {
  const source = await readFile(ROUTE_PATH, 'utf8');
  assert.match(source, /createCloudflareServices\(c\.env, c\.executionCtx\)/);
  assert.match(source, /handleMediaUpload\(c, c\.env, services\)/);
});
