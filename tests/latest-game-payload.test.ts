// The unversioned ZIP endpoint must resolve the current release from the
// canonical posts.payload_key instead of serving the original upload.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { resolveLatestGamePayloadKey } from '../functions/lib/game-version-key.ts';

const VERSION_KEY = 'versions/p.1/3f2504e0-4f89-41d3-9a0c-0305e82c3301.zip';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE posts (id TEXT PRIMARY KEY, payload_key TEXT)');
  sqlite.prepare('INSERT INTO posts VALUES (?, ?)').run('p.1', VERSION_KEY);
  sqlite.prepare('INSERT INTO posts VALUES (?, ?)').run('plain', 'zip/plain.zip');
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          values = args;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
      };
    },
  } as never;
  return { sqlite, db };
}

test('resolves a versioned payload key for the current release', async () => {
  const f = fixture();
  try {
    assert.equal(await resolveLatestGamePayloadKey(f.db, 'p.1'), VERSION_KEY);
  } finally {
    f.sqlite.close();
  }
});

test('leaves unversioned posts to the original zip fallback', async () => {
  const f = fixture();
  try {
    assert.equal(await resolveLatestGamePayloadKey(f.db, 'plain'), null);
    assert.equal(await resolveLatestGamePayloadKey(f.db, 'unknown'), null);
    assert.equal(await resolveLatestGamePayloadKey(undefined, 'p.1'), null);
  } finally {
    f.sqlite.close();
  }
});
