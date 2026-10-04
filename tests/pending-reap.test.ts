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
    const reaped = await reapStalePendingPosts({ DB: db });
    assert.equal(reaped, 1);
    const remaining = (await db.prepare(`SELECT id FROM posts`).all()).results as { id: string }[];
    assert.deepEqual(remaining.map((r) => r.id).sort(), ['fresh-pending', 'old-published']);
  });

  it('is a no-op without a database', async () => {
    assert.equal(await reapStalePendingPosts({ DB: undefined as unknown as D1Database }), 0);
  });
});
