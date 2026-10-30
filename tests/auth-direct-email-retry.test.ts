import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { resumeDirectEmailChange } from '../functions/lib/flaxia-direct-email.ts';

test('an Auth email change survives a local transaction rollback and lost acknowledgement', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, frozen_at TEXT); INSERT INTO users VALUES ('u', 'old@example.test', NULL); CREATE TABLE flaxia_direct_deletion_jobs (user_id TEXT); CREATE TABLE flaxia_auth_transition_assertions (valid INTEGER NOT NULL CHECK(valid = 1));",
  );
  db.exec(readFileSync(new URL('../migrations/0124_direct_email_changes.sql', import.meta.url), 'utf8'));
  const hash = 'A'.repeat(43),
    grant = 'B'.repeat(43),
    target = 'new@example.test';
  db.prepare("INSERT INTO flaxia_direct_email_changes VALUES (?, 'u', ?, 'pending', '2026-01-01T00:00:00Z')").run(
    hash,
    target,
  );
  type Bound = { run: () => { success: boolean; meta: { changes: number } }; first: () => unknown };
  let failLocal = true;
  const d1 = {
    prepare(sql: string) {
      const make = (...args: unknown[]): Bound => ({
        run: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
        first: () => db.prepare(sql).get(...(args as never[])) ?? null,
      });
      return { ...make(), bind: make };
    },
    async batch(statements: Bound[]) {
      db.exec('BEGIN');
      try {
        for (let i = 0; i < statements.length; i++) {
          if (failLocal && i === 4) {
            failLocal = false;
            throw new Error('injected failure');
          }
          statements[i].run();
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  let acks = 0;
  const service = {
    async fetch(request: Request) {
      if (new URL(request.url).pathname.endsWith('/status'))
        return Response.json({
          state: 'committed',
          target_hash: createHash('sha256').update(target).digest('base64url'),
        });
      if (++acks === 1) throw new Error('acknowledgement lost');
      return Response.json({ success: true });
    },
  };
  const env = { DB: d1, AUTH_SERVICE: service } as unknown as Env;
  assert.equal(await resumeDirectEmailChange(env, grant, 'u'), 'unavailable');
  assert.equal(db.prepare('SELECT email FROM users').get()?.email, 'old@example.test');
  assert.equal(await resumeDirectEmailChange(env, grant, 'u'), 'unavailable');
  assert.equal(db.prepare('SELECT email FROM users').get()?.email, target);
  assert.equal(await resumeDirectEmailChange(env, grant, 'u'), 'ok');
  assert.equal(db.prepare('SELECT count(*) AS n FROM flaxia_direct_email_changes').get()?.n, 0);
  assert.equal(acks, 2);
  db.close();
});

test('email reservations prevent conflicting registration, changes and deletion until reconciliation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, frozen_at TEXT); INSERT INTO users VALUES ('u', 'old@example.test', NULL), ('v', 'other@example.test', NULL); CREATE TABLE flaxia_direct_deletion_jobs (user_id TEXT);",
  );
  db.exec(readFileSync(new URL('../migrations/0124_direct_email_changes.sql', import.meta.url), 'utf8'));
  db.exec(
    "INSERT INTO flaxia_direct_email_changes VALUES ('op', 'u', 'reserved@example.test', 'pending', '2026-01-01T00:00:00Z')",
  );
  assert.throws(() => db.exec("UPDATE users SET email = 'reserved@example.test' WHERE id = 'v'"), /email_reserved/);
  assert.throws(() => db.exec("INSERT INTO users VALUES ('w', 'RESERVED@example.test', NULL)"), /email_reserved/);
  assert.throws(() => db.exec("UPDATE users SET email = 'else@example.test' WHERE id = 'u'"), /email_change_pending/);
  assert.throws(() => db.exec("DELETE FROM users WHERE id = 'u'"), /email_change_pending/);
  assert.throws(() => db.exec("INSERT INTO flaxia_direct_deletion_jobs VALUES ('u')"), /email_change_pending/);
  db.exec(
    "UPDATE flaxia_direct_email_changes SET state = 'applying' WHERE user_id = 'u'; UPDATE users SET email = 'reserved@example.test' WHERE id = 'u';",
  );
  assert.equal(db.prepare("SELECT email FROM users WHERE id = 'u'").get()?.email, 'reserved@example.test');
  db.close();
});
