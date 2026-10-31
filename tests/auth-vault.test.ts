import assert from 'node:assert/strict';
import test from 'node:test';
import { authVaultRequest } from '../functions/lib/flaxia-auth.ts';
import { ensureAuthVault } from '../functions/lib/flaxia-auth-vault.ts';

const grant = 'g'.repeat(43);
const userId = 'user-1';
const now = new Date().toISOString();

const localKeys = {
  salt: Buffer.alloc(16, 1).toString('base64'),
  recovery_salt: Buffer.alloc(16, 2).toString('base64'),
  kdf_params: JSON.stringify({ alg: 'PBKDF2-SHA256', iterations: 600_000 }),
  wrapped_vk: `${Buffer.alloc(12, 3).toString('base64')}.${Buffer.alloc(32, 4).toString('base64')}`,
  recovery_blob: `${Buffer.alloc(12, 5).toString('base64')}.${Buffer.alloc(32, 6).toString('base64')}`,
  vk_version: 1,
  created_at: now,
  updated_at: now,
};

function database(options: { keys?: typeof localKeys | null; devices?: unknown[]; items?: unknown[] } = {}) {
  const batches: string[][] = [];
  const keys = options.keys === undefined ? localKeys : options.keys;
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        bind: (..._args: unknown[]) => statement,
        first: async () => {
          if (sql.includes('FROM vault_keys WHERE user_id = ?')) return keys;
          return null;
        },
        all: async () => {
          if (sql.includes('FROM device_keys')) return { results: options.devices ?? [] };
          if (sql.includes('FROM vault_items')) return { results: options.items ?? [] };
          return { results: [] };
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; run(): Promise<unknown> }>) {
      batches.push(statements.map((statement) => statement.sql));
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { db, batches };
}

type VaultCall = { method: string; path: string; body?: unknown };

function authService(handler: (call: VaultCall, body: Record<string, unknown>) => Response) {
  const calls: VaultCall[] = [];
  return {
    calls,
    service: {
      fetch: async (request: Request) => {
        const body = (await request.json()) as Record<string, unknown>;
        const call = {
          method: String(body.method ?? 'POST'),
          path: typeof body.path === 'string' ? body.path : new URL(request.url).pathname,
          body: body.body,
        };
        calls.push(call);
        return handler(call, body);
      },
    },
  };
}

function environment(db: unknown, service: unknown) {
  return { DB: db, AUTH_SERVICE: service, AUTH_AUTHORITY_MODE: 'flaxia-auth' } as unknown as Env;
}

test('an empty Vault stays disabled and is never imported', async () => {
  const { db, batches } = database({ keys: null });
  const auth = authService(() => Response.json({ enabled: false }));
  const state = await ensureAuthVault(environment(db, auth.service), grant, userId);
  assert.deepEqual(state, { enabled: false, vk_version: 0 });
  assert.equal(
    auth.calls.some((call) => call.path === '/api/flaxia/vault/import'),
    false,
  );
  assert.equal(batches.length, 0);
});

test('transitional rows are imported once and only deleted after Auth confirms the envelope', async () => {
  const { db, batches } = database({
    devices: [],
    items: [{ id: 'item_aaaaaaaaaa', item_key_wrapped: 'x', payload: 'y', kind: 'private_note', vk_version: 1 }],
  });
  let enabled = false;
  const auth = authService((call, body) => {
    if (call.path === '/api/flaxia/vault/import') {
      enabled = true;
      assert.equal(body.user_id, userId);
      assert.equal((body.keys as typeof localKeys).salt, localKeys.salt);
      return Response.json({ success: true, imported: true, vk_version: 1 });
    }
    return Response.json(enabled ? { enabled: true, vk_version: 1 } : { enabled: false });
  });
  const state = await ensureAuthVault(environment(db, auth.service), grant, userId);
  assert.deepEqual(state, { enabled: true, vk_version: 1 });
  assert.equal(auth.calls.filter((call) => call.path === '/api/flaxia/vault/import').length, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].filter((sql) => sql.startsWith('DELETE FROM vault_items')).length, 1);
  assert.equal(batches[0].filter((sql) => sql.startsWith('DELETE FROM device_keys')).length, 1);
  assert.equal(batches[0].filter((sql) => sql.startsWith('DELETE FROM vault_keys')).length, 1);
});

test('a matching Auth envelope cleans up local rows without importing', async () => {
  const { db, batches } = database();
  const auth = authService(() =>
    Response.json({ enabled: true, salt: localKeys.salt, wrapped_vk: localKeys.wrapped_vk, vk_version: 1 }),
  );
  const state = await ensureAuthVault(environment(db, auth.service), grant, userId);
  assert.deepEqual(state, { enabled: true, vk_version: 1 });
  assert.equal(
    auth.calls.some((call) => call.path === '/api/flaxia/vault/import'),
    false,
  );
  assert.equal(batches.length, 1);
});

test('a different Auth envelope is never replaced and local rows are kept', async () => {
  const { db, batches } = database();
  const auth = authService(() => Response.json({ enabled: true, salt: 'other', wrapped_vk: 'other', vk_version: 9 }));
  const state = await ensureAuthVault(environment(db, auth.service), grant, userId);
  assert.deepEqual(state, { enabled: true, vk_version: 9 });
  assert.equal(batches.length, 0);
});

test('import conflicts and Auth outages fail closed', async () => {
  const conflict = authService((call) =>
    call.path === '/api/flaxia/vault/import'
      ? new Response(JSON.stringify({ error: 'vault_import_conflict' }), { status: 409 })
      : Response.json({ enabled: false }),
  );
  assert.equal(await ensureAuthVault(environment(database().db, conflict.service), grant, userId), null);

  const unavailable = authService(() => new Response(null, { status: 503 }));
  assert.equal(await ensureAuthVault(environment(database().db, unavailable.service), grant, userId), null);
});

test('the proxy sends the browser method, path and query through the grant bridge', async () => {
  const auth = authService(() => Response.json({ items: [] }));
  const result = await authVaultRequest(
    environment({}, auth.service),
    grant,
    userId,
    'GET',
    '/api/vault/items?kind=private_note',
  );
  assert.deepEqual(result, { status: 200, body: { items: [] } });
  assert.equal(auth.calls[0].method, 'GET');
  assert.equal(auth.calls[0].path, '/api/vault/items?kind=private_note');

  assert.equal(await authVaultRequest(environment({}, auth.service), grant, userId, 'PATCH', '/api/vault/keys'), null);
  assert.equal(await authVaultRequest(environment({}, auth.service), grant, userId, 'GET', '/api/other'), null);
});
