import assert from 'node:assert/strict';
import test from 'node:test';
import { extendSession, getMeWithSession, getSession } from '../functions/lib/auth.ts';

const grant = 'a'.repeat(43);
const expires = new Date(Date.now() + 60_000).toISOString();
const user = {
  id: 'user-1',
  username: 'alice',
  email: 'alice@example.test',
  display_name: 'Alice',
  bio: '',
  created_at: expires,
};

function environment(options: { linked?: boolean; authOk?: boolean } = {}) {
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      if (sql.includes('FROM flaxia_direct_vault_changes') || sql.includes('FROM flaxia_direct_email_changes'))
        return { bind: () => ({ first: async () => null }) };
      assert.match(sql, /JOIN flaxia_auth_links/);
      return {
        bind: (id: string) => ({ first: async () => (options.linked !== false && id === user.id ? user : null) }),
      };
    },
  };
  const service = {
    fetch: async (request: Request) =>
      options.authOk === false
        ? new Response(null, { status: 401 })
        : Response.json(
            new URL(request.url).pathname.endsWith('/pending')
              ? { operation: null }
              : { user_id: user.id, expires_at: expires },
          ),
  };
  return { env: { DB: db, AUTH_SERVICE: service, AUTH_AUTHORITY_MODE: 'flaxia-auth' } as unknown as Env, queries };
}

test('direct Auth grant resolves a linked profile without a local session', async () => {
  const { env, queries } = environment();
  assert.equal((await getSession(env, grant))?.session.user_id, user.id);
  assert.equal((await getMeWithSession(env, grant))?.user.id, user.id);
  assert.equal(await extendSession(env, grant), true);
  assert.equal(queries.length, 6);
});

test('unlinked profiles and revoked Auth grants are rejected', async () => {
  assert.equal(await getSession(environment({ linked: false }).env, grant), null);
  const revoked = environment({ authOk: false });
  assert.equal(await getSession(revoked.env, grant), null);
  assert.equal(await getMeWithSession(revoked.env, grant), null);
  assert.equal(await extendSession(revoked.env, grant), false);
  assert.equal(revoked.queries.length, 0);
});

test('legacy mode cannot accept a direct Auth grant as a local session', async () => {
  const { env } = environment();
  const legacy = { ...env, AUTH_AUTHORITY_MODE: undefined } as unknown as Env;
  assert.equal(await getSession(legacy, grant), null);
  assert.equal(await getMeWithSession(legacy, grant), null);
});
