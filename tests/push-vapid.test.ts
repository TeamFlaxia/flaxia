// Regression: /api/push/vapid-key 500'd when VAPID secrets are not
// configured, because ensureVapid read the undeclared globals directly
// (ReferenceError) instead of falling back to generated dev keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_URL } from './helpers/setup.ts';

test('GET /api/push/vapid-key works without configured VAPID secrets', async () => {
  const res = await fetch(`${BASE_URL}/api/push/vapid-key`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { publicKey?: unknown };
  assert.equal(typeof data.publicKey, 'string');
  assert.ok((data.publicKey as string).length > 0);
});
