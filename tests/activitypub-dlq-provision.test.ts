import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureActivityPubDlq } from '../scripts/ensure-activitypub-dlq.mjs';

const env = { CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-token' };
for (const exists of [true, false]) {
  test(`DLQ provisioning is idempotent (queue exists: ${exists})`, async () => {
    const methods: string[] = [];
    const checks: string[] = [];
    let created = false;
    await ensureActivityPubDlq(env, async (url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      if (!init.method) {
        checks.push(url);
        // The queue is visible on the second GET (after the POST).
        const visible = exists || created;
        return Response.json({ success: true, result: visible ? [{ queue_name: 'activitypub-delivery-dlq' }] : [] });
      }
      assert.equal(init.body, JSON.stringify({ queue_name: 'activitypub-delivery-dlq' }));
      created = true;
      return Response.json({ success: true, result: {} });
    });
    // The queue is listed before creation (idempotency) and again afterwards
    // (verification that the deploy can bind a consumer to it).
    assert.deepEqual(methods, exists ? ['GET'] : ['GET', 'POST', 'GET']);
    assert.equal(checks.length, exists ? 1 : 2);
    assert.ok(checks.every((url) => url.includes('name=activitypub-delivery-dlq')));
  });
}

test('DLQ provisioning fails when the created queue does not become visible', async () => {
  let created = false;
  await assert.rejects(
    ensureActivityPubDlq(env, async (_url: string, init: RequestInit) => {
      if (!init.method) return Response.json({ success: true, result: created ? [] : [] });
      created = true;
      return Response.json({ success: true, result: {} });
    }),
    /not visible/,
  );
});

test('DLQ provisioning refuses to hide Cloudflare API failures', async () => {
  await assert.rejects(
    ensureActivityPubDlq(env, async () => Response.json({ success: false }, { status: 403 })),
    /403/,
  );
});
