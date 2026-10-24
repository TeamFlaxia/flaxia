import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';

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
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});
const { default: admin } = await import('../functions/api/routes/admin.ts');

function fixture(role: string | null = 'admin', failWrite = false) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, hashtags TEXT, hidden INTEGER);
    INSERT INTO posts VALUES ('post', '["art","custom"]', 0),
      ('hidden', '["r18"]', 1), ('tagged', '["NSFW","art"]', 0), ('empty', NULL, 0);`);
  let queries = 0;
  const db = {
    prepare(sql: string) {
      queries++;
      const statement = {
        values: [] as SQLInputValue[],
        bind(...values: SQLInputValue[]) {
          this.values = values;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...this.values) ?? null;
        },
        async run() {
          if (failWrite) return { success: false };
          sqlite.prepare(sql).run(...this.values);
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', role === null ? null : ({ id: 'admin-id', username: 'operator', role } as Variables['user']));
    await next();
  });
  app.route('/api/admin', admin);
  return {
    sqlite,
    queryCount: () => queries,
    request: (id: string, database: D1Database | undefined = db) =>
      app.request(`/api/admin/posts/${id}/nsfw`, { method: 'POST' }, { DB: database, ADMIN_USERNAMES: '' } as Bindings),
    withoutDb: () => app.request('/api/admin/posts/post/nsfw', { method: 'POST' }, {} as Bindings),
  };
}

test('manual NSFW moderation requires admin before accessing the database', async () => {
  for (const role of [null, 'user', 'reviewer']) {
    const f = fixture(role);
    try {
      assert.equal((await f.request('post')).status, role === null ? 401 : 403);
      assert.equal(f.queryCount(), 0);
      assert.equal(
        f.sqlite.prepare('SELECT hashtags FROM posts WHERE id = ?').get('post')?.hashtags,
        '["art","custom"]',
      );
    } finally {
      f.sqlite.close();
    }
  }
});

test('admin can mark any post without scans or reports, preserving tags and hidden state', async () => {
  const f = fixture();
  try {
    for (const id of ['post', 'hidden', 'empty']) {
      const before = f.sqlite.prepare('SELECT hidden FROM posts WHERE id = ?').get(id);
      const response = await f.request(id);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, changed: true });
      const row = f.sqlite.prepare('SELECT hashtags, hidden FROM posts WHERE id = ?').get(id);
      assert.equal(row?.hidden, before?.hidden);
      assert.ok(JSON.parse(row?.hashtags as string).includes('nsfw'));
    }
    assert.deepEqual(
      JSON.parse(f.sqlite.prepare('SELECT hashtags FROM posts WHERE id = ?').get('post')?.hashtags as string),
      ['art', 'custom', 'nsfw'],
    );
    assert.deepEqual(await (await f.request('post')).json(), { success: true, changed: false });
    assert.deepEqual(await (await f.request('tagged')).json(), { success: true, changed: false });
    assert.equal(f.sqlite.prepare('SELECT hashtags FROM posts WHERE id = ?').get('tagged')?.hashtags, '["NSFW","art"]');
    assert.equal((await f.request('missing')).status, 404);
    assert.equal((await f.withoutDb()).status, 503);
  } finally {
    f.sqlite.close();
  }
});

test('write failures are not reported as successful moderation', async () => {
  const f = fixture('admin', true);
  try {
    const response = await f.request('post');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to mark post as NSFW' });
  } finally {
    f.sqlite.close();
  }
});
