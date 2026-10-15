import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { reapStalePendingPosts } from '../functions/lib/pending-reap.ts';

// Minimal D1 shim: only prepare/bind/run/all/first are used.
function testDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    `CREATE TABLE posts (id TEXT PRIMARY KEY, status TEXT, created_at TEXT,
      gif_key TEXT, payload_key TEXT, swf_key TEXT, thumbnail_key TEXT)`,
  );
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(binds as never[]));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...(binds as never[])) };
        },
        async first() {
          return sqlite.prepare(sql).get(...(binds as never[])) ?? null;
        },
      };
    },
  };
  return db as unknown as D1Database;
}

describe('reapStalePendingPosts', () => {
  it('removes only pending rows older than 24h', async () => {
    const db = testDb();
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    for (const [id, status, created] of [
      ['stale-pending', 'pending', old],
      ['fresh-pending', 'pending', fresh],
      ['old-published', 'published', old],
    ] as const) {
      await db.prepare(`INSERT INTO posts (id, status, created_at) VALUES (?, ?, ?)`).bind(id, status, created).run();
    }
    const deleted: string[] = [];
    const bucket = {
      async list() {
        return { objects: [], truncated: false };
      },
      async delete(keys: string[]) {
        deleted.push(...keys);
      },
    } as unknown as R2Bucket;
    const reaped = await reapStalePendingPosts({ DB: db, BUCKET: bucket });
    assert.equal(reaped, 1);
    const remaining = (await db.prepare(`SELECT id FROM posts`).all()).results as { id: string }[];
    assert.deepEqual(remaining.map((r) => r.id).sort(), ['fresh-pending', 'old-published']);
  });

  it('retains pending rows if the R2 binding is unavailable', async () => {
    const db = testDb();
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await db
      .prepare('INSERT INTO posts (id, status, created_at) VALUES (?, ?, ?)')
      .bind('stale-pending', 'pending', old)
      .run();
    assert.equal(await reapStalePendingPosts({ DB: db }), 0);
    assert.ok(await db.prepare('SELECT id FROM posts WHERE id = ?').bind('stale-pending').first());
  });

  it('deletes all uploaded attachment prefixes before dropping a pending row', async () => {
    const db = testDb();
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await db
      .prepare('INSERT INTO posts (id, status, created_at, gif_key) VALUES (?, ?, ?, ?)')
      .bind('stale', 'pending', old, 'gif/stale.png')
      .run();
    const deleted: string[] = [];
    const bucket = {
      async list({ prefix }: { prefix: string }) {
        return { objects: prefix === 'docs/stale/' ? [{ key: 'docs/stale/29.pdf' }] : [], truncated: false };
      },
      async delete(keys: string[]) {
        deleted.push(...keys);
      },
    } as unknown as R2Bucket;
    assert.equal(await reapStalePendingPosts({ DB: db, BUCKET: bucket }), 1);
    assert.deepEqual(deleted.sort(), ['docs/stale/29.pdf', 'gif/stale.png']);
  });

  it('is a no-op without a database', async () => {
    assert.equal(await reapStalePendingPosts({ DB: undefined as unknown as D1Database }), 0);
  });
});
