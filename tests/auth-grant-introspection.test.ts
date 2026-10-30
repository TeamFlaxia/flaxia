import assert from 'node:assert/strict';
import test from 'node:test';
import { introspectAuthGrant } from '../functions/lib/flaxia-auth.ts';

const grant = 'a'.repeat(43);
const future = new Date(Date.now() + 60_000).toISOString();

function service(body: unknown, status = 200) {
  return { fetch: async () => Response.json(body, { status }) } as unknown as Fetcher;
}

test('Auth grant introspection resolves the Auth identity and expiry without a local database', async () => {
  let calls = 0;
  const binding = {
    fetch: async (request: Request) => {
      calls++;
      assert.equal(new URL(request.url).pathname, '/api/flaxia/introspect');
      assert.deepEqual(await request.json(), { grant });
      return Response.json({ user_id: 'auth-user', expires_at: future });
    },
  } as unknown as Fetcher;
  assert.deepEqual(await introspectAuthGrant({ AUTH_SERVICE: binding }, grant), {
    user_id: 'auth-user',
    expires_at: future,
  });
  assert.equal(calls, 1);
});

test('Auth grant introspection fails closed on invalid tokens, expiry, responses and outages', async () => {
  assert.equal(await introspectAuthGrant({ AUTH_SERVICE: service({}) }, 'bad'), null);
  assert.equal(await introspectAuthGrant({ AUTH_SERVICE: service({ user_id: 'u', expires_at: 'bad' }) }, grant), null);
  assert.equal(
    await introspectAuthGrant({ AUTH_SERVICE: service({ user_id: 'u', expires_at: '2000-01-01T00:00:00Z' }) }, grant),
    null,
  );
  assert.equal(
    await introspectAuthGrant({ AUTH_SERVICE: service({ user_id: 'u', expires_at: future }, 401) }, grant),
    null,
  );
  assert.equal(await introspectAuthGrant({}, grant), null);
});
