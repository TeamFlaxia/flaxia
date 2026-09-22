// The SRP implementation ships twice, byte for byte: once for the browser
// bundle (src/lib/srp.ts) and once for the Workers bundle (functions/lib/srp.ts).
// They are separate files because the two build targets have separate roots, so
// nothing enforces they stay in step — and a drift means one side derives x
// differently from the other, which fails as "invalid credentials" for every
// user rather than as a build error.
//
// Both sides agree on the KDF via users.srp_kdf, but the *code* that reads it
// must be identical, so this test compares the sources directly.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const CLIENT_PATH = new URL('../src/lib/srp.ts', import.meta.url);
const SERVER_PATH = new URL('../functions/lib/srp.ts', import.meta.url);

test('client and server SRP modules are byte-identical', async () => {
  const [client, server] = await Promise.all([readFile(CLIENT_PATH, 'utf8'), readFile(SERVER_PATH, 'utf8')]);
  assert.equal(
    client,
    server,
    'functions/lib/srp.ts is a copy of src/lib/srp.ts — edit both, or copy one over the other',
  );
});
