// The SRP implementation lives once in shared/srp.ts. The browser bundle and
// the Workers bundle still need separate entrypoints because their build roots
// differ, so src/lib/srp.ts and functions/lib/srp.ts are identical re-exports.
//
// This test keeps those entrypoints from drifting: if one side starts carrying
// its own implementation again, the two files diverge and this test fails.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const CLIENT_PATH = new URL('../src/lib/srp.ts', import.meta.url);
const SERVER_PATH = new URL('../functions/lib/srp.ts', import.meta.url);
const SHARED_PATH = new URL('../shared/srp.ts', import.meta.url);

test('client and server SRP entrypoints are byte-identical re-exports', async () => {
  const [client, server] = await Promise.all([readFile(CLIENT_PATH, 'utf8'), readFile(SERVER_PATH, 'utf8')]);
  assert.equal(client, server, 'functions/lib/srp.ts must mirror src/lib/srp.ts; both should re-export shared/srp.ts');
  assert.match(client, /from '\.\.\/\.\.\/shared\/srp\.ts'/);
});

test('shared SRP module carries the implementation', async () => {
  const shared = await readFile(SHARED_PATH, 'utf8');
  assert.match(shared, /export async function clientStep1/);
  assert.match(shared, /export async function serverStep1/);
});
