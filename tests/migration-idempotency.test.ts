// Replay safety for D1 migrations.
//
// Production D1 remembers which files it applied, but local databases and
// manual re-runs can execute a migration twice. Migrations in the 0149+ AP
// series opt into the IF NOT EXISTS convention, so replaying them must be a
// no-op. Older migrations are one-shot DDL (bare CREATE TABLE / ALTER TABLE ADD
// COLUMN) and cannot be replayed; rewriting those is out of scope here, so the
// replay pass tolerates only those legacy files and stays strict about AP.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_DIR = join(ROOT, 'migrations');
const migrationFiles = readdirSync(MIGRATION_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const IDEMPOTENT_MIGRATIONS = new Set(['0149_ap_dlq.sql', '0150_ap_pool.sql', '0151_ap_dlq_retention.sql']);
const POOL_INDEXES = ['idx_ap_pool_fetched', 'idx_ap_pool_instance', 'idx_ap_pool_score'];

function migrationSql(file: string): string {
  return readFileSync(join(MIGRATION_DIR, file), 'utf8');
}

/** Apply migration files in filename order, like the D1 migrator does. */
function applyMigrations(
  db: DatabaseSync,
  files: readonly string[],
  onError?: (file: string, error: unknown) => void,
): void {
  for (const file of files) {
    try {
      db.exec(migrationSql(file));
    } catch (error) {
      if (!onError) throw error;
      onError(file, error);
    }
  }
}

function poolIndexes(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA index_list('ap_pool_metrics')").all() as Array<{
    name: string;
    origin: string;
  }>;
  return rows
    .filter((row) => row.origin === 'c')
    .map((row) => row.name)
    .sort();
}

describe('migration replay idempotency', () => {
  it('replays migrations on the same database without failing AP files or losing pool rows/indexes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      applyMigrations(db, migrationFiles);
      assert.deepEqual(poolIndexes(db), POOL_INDEXES);

      db.exec(
        `INSERT INTO ap_pool_metrics (post_id, instance, favourites, reblogs, score, fetched_at)
         VALUES ('pool-1', 'mastodon.test', 3, 2, 4.25, '2026-01-01T00:00:00.000Z')`,
      );

      // Second pass across the whole migration set. Legacy one-shot files may
      // fail; none of the AP files may.
      const replayFailures: string[] = [];
      applyMigrations(db, migrationFiles, (file) => {
        replayFailures.push(file);
      });
      assert.deepEqual(
        replayFailures.filter((file) => IDEMPOTENT_MIGRATIONS.has(file)),
        [],
        '0149-0151 must be safe to replay on an already-migrated database',
      );

      const row = db
        .prepare(
          'SELECT post_id, instance, favourites, reblogs, score, fetched_at FROM ap_pool_metrics WHERE post_id = ?',
        )
        .get('pool-1') as Record<string, unknown> | undefined;
      assert.ok(row, 'the pool row must survive a migration replay');
      assert.equal(row.instance, 'mastodon.test');
      assert.equal(row.favourites, 3);
      assert.equal(row.reblogs, 2);
      assert.equal(row.score, 4.25);
      assert.equal(row.fetched_at, '2026-01-01T00:00:00.000Z');
      assert.deepEqual(poolIndexes(db), POOL_INDEXES, 'the pool indexes must survive a replay');

      // The exact regression: 0150 used bare CREATE TABLE/CREATE INDEX, so its
      // second execution threw "table ap_pool_metrics already exists".
      assert.doesNotThrow(() => {
        applyMigrations(db, ['0150_ap_pool.sql']);
        applyMigrations(db, ['0150_ap_pool.sql']);
      });
      const count = db.prepare('SELECT COUNT(*) AS count FROM ap_pool_metrics').get() as { count: number };
      assert.equal(count.count, 1);
      assert.deepEqual(poolIndexes(db), POOL_INDEXES);
    } finally {
      db.close();
    }
  });
});
