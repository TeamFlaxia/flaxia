import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { reapProfileMedia } from '../functions/lib/profile-media-reap.ts';

test('profile media cleanup retries failed R2 deletion and prevents reusing a pending key', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, avatar_key TEXT, header_key TEXT);');
  db.exec(readFileSync(new URL('../migrations/0124_profile_media_deletion_outbox.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO profile_media_deletion_outbox (object_key) VALUES ('avatar/hash');");
  assert.throws(() => db.exec("INSERT INTO users VALUES ('u', 'avatar/hash', NULL)"), /profile_media_deletion_pending/);
  type Bound = { run: () => { success: boolean; meta: { changes: number } }; all: () => { results: unknown[] } };
  const d1 = {
    prepare(sql: string) {
      const make = (...args: unknown[]): Bound => ({
        run: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
        all: () => ({ results: db.prepare(sql).all(...(args as never[])) }),
      });
      return { ...make(), bind: make };
    },
  } as unknown as D1Database;
  let attempts = 0;
  const bucket = {
    delete: async (key: string) => {
      assert.equal(key, 'avatar/hash');
      if (++attempts === 1) throw new Error('R2 outage');
    },
  } as unknown as R2Bucket;
  assert.equal(await reapProfileMedia({ DB: d1, BUCKET: bucket }), 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_media_deletion_outbox').get()?.n, 1);
  assert.throws(() => db.exec("INSERT INTO users VALUES ('u', 'avatar/hash', NULL)"), /profile_media_deletion_pending/);
  assert.equal(await reapProfileMedia({ DB: d1, BUCKET: bucket }), 1);
  db.exec("INSERT INTO users VALUES ('u', 'avatar/hash', NULL)");
  assert.equal(attempts, 2);
  db.close();
});

test('concurrent cleanup workers cannot delete a reused key after releasing the outbox guard', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, avatar_key TEXT, header_key TEXT);');
  db.exec(readFileSync(new URL('../migrations/0124_profile_media_deletion_outbox.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO profile_media_deletion_outbox (object_key) VALUES ('avatar/hash');");
  type Bound = { run: () => { success: boolean; meta: { changes: number } }; all: () => { results: unknown[] } };
  const d1 = {
    prepare(sql: string) {
      const make = (...args: unknown[]): Bound => ({
        run: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
        all: () => ({ results: db.prepare(sql).all(...(args as never[])) }),
      });
      return { ...make(), bind: make };
    },
  } as unknown as D1Database;
  let unblock = () => {},
    started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let calls = 0;
  const bucket = {
    delete: async () => {
      calls++;
      started();
      await wait;
    },
  } as unknown as R2Bucket;
  const first = reapProfileMedia({ DB: d1, BUCKET: bucket });
  await running;
  assert.equal(await reapProfileMedia({ DB: d1, BUCKET: bucket }), 0);
  assert.throws(() => db.exec("INSERT INTO users VALUES ('u', 'avatar/hash', NULL)"), /profile_media_deletion_pending/);
  unblock();
  assert.equal(await first, 1);
  db.exec("INSERT INTO users VALUES ('u', 'avatar/hash', NULL)");
  assert.equal(calls, 1);
  db.close();
});
