import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  credentialStamp,
  exchangeAuthCode,
  isSessionAuthorized,
  revokeAuthGrant,
  startAuthReauth,
  verifyAuthReauth,
  withPendingAuthGrant,
} from '../functions/lib/flaxia-auth.ts';

const token = 'A'.repeat(43);

test('unclaimed exchange grants are revoked on rejection or failure', async () => {
  let revocations = 0;
  const service = {
    fetch: async (request: Request) => {
      assert.equal(new URL(request.url).pathname, '/api/flaxia/revoke');
      assert.deepEqual(await request.json(), { grant: token });
      revocations++;
      return Response.json({ success: true });
    },
  } as unknown as Fetcher;
  const env = { AUTH_SERVICE: service };
  assert.equal(await withPendingAuthGrant(env, token, async () => 409), 409);
  await assert.rejects(
    withPendingAuthGrant(env, token, async () => {
      throw new Error('database failure');
    }),
  );
  assert.equal(
    await withPendingAuthGrant(env, token, async (commit) => {
      commit();
      return 200;
    }),
    200,
  );
  assert.equal(revocations, 2);
});
const credentials = {
  password_hash: '',
  srp_salt: 'salt',
  srp_verifier: 'verifier',
  srp_group: '2048',
  srp_kdf: 'sha256-v1',
};
const initialStamp = createHash('sha256')
  .update(JSON.stringify(['salt', 'verifier', '2048', 'sha256-v1']))
  .digest('base64url');
const sessionEnv = (grant: string | null, service: Fetcher, user = credentials) =>
  ({
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () =>
            sql.includes('grant_token')
              ? grant
                ? { grant_token: grant, auth_stamp: token, source_stamp: initialStamp }
                : null
              : user,
        }),
      }),
    },
    AUTH_SERVICE: service,
  }) as unknown as Env;

test('Auth sessions fail closed when revoked, unavailable, or credentials diverge', async () => {
  const offline = {
    fetch: async () => {
      throw new Error('offline');
    },
  } as unknown as Fetcher;
  assert.deepEqual(await credentialStamp(sessionEnv(token, offline).DB, 'alice'), {
    stamp: initialStamp,
    legacy: false,
  });
  const ok = { fetch: async () => Response.json({ user_id: 'alice', credential_stamp: token }) } as unknown as Fetcher;
  const revoked = { fetch: async () => new Response('', { status: 401 }) } as unknown as Fetcher;
  const wrongUser = {
    fetch: async () => Response.json({ user_id: 'bob', credential_stamp: token }),
  } as unknown as Fetcher;
  assert.equal(await isSessionAuthorized(sessionEnv(null, offline), 's', 'alice'), true);
  assert.equal(await isSessionAuthorized(sessionEnv(token, ok), 's', 'alice'), true);
  assert.equal(
    await isSessionAuthorized(sessionEnv(token, ok, { ...credentials, srp_verifier: 'changed' }), 's', 'alice'),
    false,
  );
  assert.equal(await isSessionAuthorized(sessionEnv(token, revoked), 's', 'alice'), false);
  assert.equal(await isSessionAuthorized(sessionEnv(token, wrongUser), 's', 'alice'), false);
  assert.equal(await isSessionAuthorized(sessionEnv(token, offline), 's', 'alice'), false);
});

test('exchange validates the response and fails closed', async () => {
  const valid = {
    fetch: async () => Response.json({ user_id: 'alice', grant: token, credential_stamp: token, legacy_stamp: null }),
  } as unknown as Fetcher;
  const invalid = {
    fetch: async () => Response.json({ user_id: 'alice', grant: 'bad', credential_stamp: token, legacy_stamp: null }),
  } as unknown as Fetcher;
  assert.deepEqual(await exchangeAuthCode({ AUTH_SERVICE: valid }, token, token), {
    user_id: 'alice',
    grant: token,
    credential_stamp: token,
    legacy_stamp: null,
  });
  assert.equal(await exchangeAuthCode({ AUTH_SERVICE: invalid }, token, token), null);
  assert.equal(await exchangeAuthCode({ AUTH_SERVICE: valid }, 'bad', token), null);
});

test('legacy credential stamp matches the salted legacy hash', async () => {
  const legacy = { password_hash: 'old-hash', srp_salt: null, srp_verifier: null, srp_group: '2048', srp_kdf: null };
  const db = { prepare: () => ({ bind: () => ({ first: async () => legacy }) }) } as unknown as D1Database;
  const expected = createHash('sha256')
    .update(JSON.stringify(['legacy', legacy.password_hash]))
    .digest('base64url');
  assert.deepEqual(await credentialStamp(db, 'alice'), { stamp: expected, legacy: true });
});

test('reauthentication uses the grant and binds proof to the local user', async () => {
  const service = {
    fetch: async (request: Request) => {
      const body = (await request.json()) as { grant: string; user_id: string; challenge_id?: string };
      assert.equal(body.grant, token);
      assert.equal(body.user_id, 'alice');
      if (new URL(request.url).pathname.endsWith('/start'))
        return Response.json({ challenge_id: 'c', salt: 's', B: 'b', srp_kdf: 'sha256-v1' });
      return Response.json({ valid: body.challenge_id === 'c' });
    },
  } as unknown as Fetcher;
  assert.equal((await startAuthReauth({ AUTH_SERVICE: service }, token, 'alice'))?.challenge_id, 'c');
  assert.equal(
    await verifyAuthReauth({ AUTH_SERVICE: service }, token, 'alice', { challenge_id: 'c', A: 'a', M1: 'm' }),
    true,
  );
});

test('Flaxia logout can revoke its Auth grant and reports service failures', async () => {
  const ok = {
    fetch: async (request: Request) => {
      assert.equal(new URL(request.url).pathname, '/api/flaxia/revoke');
      assert.deepEqual(await request.json(), { grant: token });
      return Response.json({ success: true });
    },
  } as unknown as Fetcher;
  const bad = { fetch: async () => new Response('', { status: 503 }) } as unknown as Fetcher;
  assert.equal(await revokeAuthGrant({ AUTH_SERVICE: ok }, token), true);
  assert.equal(await revokeAuthGrant({ AUTH_SERVICE: bad }, token), false);
  assert.equal(await revokeAuthGrant({}, token), false);
  assert.equal(await revokeAuthGrant({ AUTH_SERVICE: ok }, 'invalid'), false);
});

test('Auth-only mode rejects old sessions and requires the Auth service', async () => {
  const ok = { fetch: async () => Response.json({ user_id: 'alice', credential_stamp: token }) } as unknown as Fetcher;
  const legacy = sessionEnv(null, ok) as Env & { AUTH_AUTHORITY_MODE?: string };
  legacy.AUTH_AUTHORITY_MODE = 'flaxia-auth';
  assert.equal(await isSessionAuthorized(legacy, 'old-session', 'alice'), false);
  const migrated = sessionEnv(token, ok) as Env & { AUTH_AUTHORITY_MODE?: string };
  migrated.AUTH_AUTHORITY_MODE = 'flaxia-auth';
  assert.equal(await isSessionAuthorized(migrated, 'auth-session', 'alice'), true);
});
