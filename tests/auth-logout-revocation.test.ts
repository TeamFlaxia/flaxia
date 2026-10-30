import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      )
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      throw error;
    }
  },
});
const { default: auth } = await import('../functions/api/routes/auth.ts');

const session = 's'.repeat(32);
const grant = 'A'.repeat(43);

function environment(options: { mapped?: boolean; service: Fetcher }) {
  let deleted = 0;
  let authRevocations = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind: (value: string) => ({
          async first() {
            assert.match(sql, /FROM flaxia_auth_sessions/);
            assert.equal(value, session);
            return options.mapped === false ? null : { grant_token: grant };
          },
          async run() {
            assert.match(sql, /DELETE FROM sessions/);
            assert.equal(value, session);
            deleted++;
            return { success: true, meta: { changes: 1 } };
          },
        }),
      };
    },
  };
  const service = {
    fetch: async (request: Request) => {
      authRevocations++;
      assert.equal(new URL(request.url).pathname, '/api/flaxia/revoke');
      assert.deepEqual(await request.json(), { grant });
      return options.service.fetch(request);
    },
  } as unknown as Fetcher;
  return {
    env: { DB: db, AUTH_SERVICE: service, BASE_URL: 'https://flaxia.app' } as unknown as Env,
    deleted: () => deleted,
    revocations: () => authRevocations,
  };
}

test('Auth revocation failure keeps the local session and cookie for a safe retry', async () => {
  for (const service of [
    { fetch: async () => new Response(null, { status: 503 }) },
    {
      fetch: async () => {
        throw new Error('service binding unavailable');
      },
    },
  ] as unknown as Fetcher[]) {
    const state = environment({ service });
    const response = await auth.request(
      '/logout',
      {
        method: 'POST',
        headers: { Cookie: `session=${session}` },
      },
      state.env,
    );
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal(state.deleted(), 0, 'a failed Auth revocation must not delete the local session');
    assert.equal(response.headers.get('Set-Cookie'), null, 'a failed logout must keep the cookie');
    assert.equal(state.revocations(), 1);
  }
});

test('logout revokes the mapped grant, deletes the local session and clears the cookie', async () => {
  const state = environment({ service: { fetch: async () => Response.json({ success: true }) } as unknown as Fetcher });
  const response = await auth.request(
    '/logout',
    {
      method: 'POST',
      headers: { Cookie: `session=${session}` },
    },
    state.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(state.revocations(), 1);
  assert.equal(state.deleted(), 1);
  assert.match(response.headers.get('Set-Cookie') ?? '', /^session=;.*Max-Age=0$/);
});

test('a local session without an Auth mapping logs out without requiring the service', async () => {
  let called = false;
  const state = environment({
    mapped: false,
    service: {
      fetch: async () => {
        called = true;
        return Response.json({ success: true });
      },
    } as unknown as Fetcher,
  });
  const response = await auth.request(
    '/logout',
    {
      method: 'POST',
      headers: { Cookie: `session=${session}` },
    },
    state.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(called, false);
  assert.equal(state.deleted(), 1);
});

test('a direct Auth grant revokes itself without a local session row', async () => {
  let called = 0;
  let sql = '';
  const db = {
    prepare(statement: string) {
      sql = statement;
      return {
        bind: () => ({
          first: async () => assert.fail('a direct grant must not be looked up in D1'),
          run: async () => assert.fail('a direct grant has no local session row'),
        }),
      };
    },
  };
  const service = {
    fetch: async (request: Request) => {
      called++;
      assert.deepEqual(await request.json(), { grant });
      return Response.json({ success: true });
    },
  } as unknown as Fetcher;
  const response = await auth.request(
    '/logout',
    {
      method: 'POST',
      headers: { Cookie: `session=${grant}` },
    },
    { DB: db, AUTH_SERVICE: service, BASE_URL: 'https://flaxia.app' } as unknown as Env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(called, 1);
  assert.equal(sql, '');
});
