import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bindings } from '../functions/api/types.ts';
import { syncLegacySrp } from '../functions/lib/auth-migration.ts';

const secret = 'test-secret-for-legacy-sync-32-bytes-minimum';
const account = {
  id: 'user-1',
  srp_salt: 'test-salt',
  srp_verifier: 'test-verifier',
  srp_group: '2048',
  srp_kdf: 'pbkdf2-600k-v2',
};
function environment(row: typeof account | null, key = secret): Bindings {
  return {
    LEGACY_SYNC_SECRET: key,
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
  } as unknown as Bindings;
}

test('sends an authenticated SRP credential without a password', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let sent = false;
  globalThis.fetch = async (input, init) => {
    sent = true;
    assert.equal(input, 'https://auth.flaxia.app/api/internal/legacy-sync');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    const timestamp = headers.get('X-Flaxia-Timestamp');
    const signature = headers.get('X-Flaxia-Signature');
    assert.ok(timestamp && signature);
    const body = String(init?.body);
    assert.deepEqual(JSON.parse(body), {
      user_id: account.id,
      salt: account.srp_salt,
      verifier: account.srp_verifier,
      group: account.srp_group,
      kdf: account.srp_kdf,
    });
    assert.equal(body.includes(secret), false);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    assert.equal(
      await crypto.subtle.verify(
        'HMAC',
        key,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(`${timestamp}.${body}`),
      ),
      true,
    );
    return new Response('{}', { status: 200 });
  };
  await syncLegacySrp(environment(account), account.id);
  assert.equal(sent, true);
});

test('does not send without a key or for unsupported credentials', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new Error('unexpected request');
  };
  await syncLegacySrp(environment(account, ''), account.id);
  await syncLegacySrp(environment({ ...account, srp_kdf: 'sha256-v1' }), account.id);
  await syncLegacySrp(environment(null), account.id);
});

test('reports transfer failures for retry', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(syncLegacySrp(environment(account), account.id), /sync failed/);
});
