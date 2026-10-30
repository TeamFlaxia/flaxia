import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { purgeLinkedLocalCredentials } from '../functions/lib/flaxia-auth.ts';

test('linked migration atomically removes local credentials, copied verifiers, sessions and SRP challenges', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT, srp_salt TEXT, srp_verifier TEXT, srp_group TEXT, srp_kdf TEXT, frozen_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE flaxia_auth_sessions (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, grant_token TEXT, auth_stamp TEXT, source_stamp TEXT);
    CREATE TABLE srp_handshakes (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY REFERENCES users(id));
    INSERT INTO users VALUES ('u', 'name', 'Name', 'legacy', 'salt', 'verifier', '2048', 'pbkdf2-600k-v2', NULL);
    INSERT INTO sessions VALUES ('s', 'u'); INSERT INTO srp_handshakes VALUES ('h', 'u');`);
  for (const migration of [
    '0115_auth_provision_guard.sql',
    '0116_auth_deletion_jobs.sql',
    '0117_auth_link_guard.sql',
    '0118_auth_credential_jobs.sql',
    '0119_auth_credential_recovery.sql',
    '0120_direct_auth_vault_changes.sql',
    '0121_auth_credential_purge.sql',
    '0122_direct_auth_deletion.sql',
  ])
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  db.exec(
    "INSERT INTO flaxia_auth_links VALUES ('u'); INSERT INTO flaxia_auth_provisioning VALUES ('u', 'name', 'Name', 'salt', 'verifier', '2048', 'pbkdf2-600k-v2');",
  );
  type Bound = { run: () => { success: boolean; meta: { changes: number } }; first: () => unknown };
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
        for (const s of statements) s.run();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
  db.exec("INSERT INTO flaxia_direct_vault_changes VALUES ('op', 'u', 'stamp', NULL, 'pending');");
  assert.equal(await purgeLinkedLocalCredentials(d1, 'u'), false);
  assert.equal(db.prepare('SELECT srp_verifier FROM users').get()?.srp_verifier, 'verifier');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1);
  db.exec("UPDATE flaxia_direct_vault_changes SET state = 'cancelled' WHERE operation_hash = 'op';");
  assert.equal(await purgeLinkedLocalCredentials(d1, 'u'), true);
  const user = db.prepare('SELECT password_hash, srp_salt, srp_verifier, srp_group, srp_kdf FROM users').get();
  assert.deepEqual(
    { ...user },
    { password_hash: '', srp_salt: null, srp_verifier: null, srp_group: null, srp_kdf: null },
  );
  for (const table of ['sessions', 'srp_handshakes', 'flaxia_auth_provisioning', 'flaxia_auth_purge_in_progress'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM flaxia_auth_links').get()?.n, 1);
  assert.equal(await purgeLinkedLocalCredentials(d1, 'u'), true);
  db.close();
});
