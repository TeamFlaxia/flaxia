import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/api/market/checkout.ts';

test('market checkout rejects revoked Auth grants and local sessions in Auth-only mode', async () => {
  for (const mode of ['revoked', 'auth-only']) {
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              if (sql.includes('FROM sessions')) return { user_id: 'alice' };
              if (sql.includes('grant_token'))
                return mode === 'revoked'
                  ? { grant_token: 'A'.repeat(43), auth_stamp: 'stamp', source_stamp: 'stamp' }
                  : null;
              throw new Error(`Unexpected query: ${sql}`);
            },
          }),
        }),
      },
      AUTH_AUTHORITY_MODE: 'flaxia-auth',
      AUTH_SERVICE: { fetch: async () => new Response(null, { status: 401 }) },
    };
    const response = await onRequest({
      request: new Request('https://flaxia.app/api/market/checkout', {
        method: 'POST',
        headers: { Cookie: 'session=token' },
      }),
      env,
      waitUntil: () => {},
    });
    assert.equal(response.status, 401, mode);
  }
});
