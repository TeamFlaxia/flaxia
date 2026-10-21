import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureActivityPubDlq } from '../scripts/ensure-activitypub-dlq.mjs';

const env = { CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-token' };
for (const exists of [true, false]) {
  test(`DLQ provisioning is idempotent (queue exists: ${exists})`, async () => {
    const methods: string[] = [];
    await ensureActivityPubDlq(env, async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      if (!init.method)
        return Response.json({ success: true, result: exists ? [{ queue_name: 'activitypub-delivery-dlq' }] : [] });
      assert.equal(init.body, JSON.stringify({ queue_name: 'activitypub-delivery-dlq' }));
      return Response.json({ success: true, result: {} });
    });
    assert.deepEqual(methods, exists ? ['GET'] : ['GET', 'POST']);
  });
}
test('DLQ provisioning refuses to hide Cloudflare API failures', async () => {
  await assert.rejects(
    ensureActivityPubDlq(env, async () => Response.json({ success: false }, { status: 403 })),
    /403/,
  );
});
