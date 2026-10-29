import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { credentialStampFor } from '../functions/lib/flaxia-auth.ts';
import { resumeAuthCredentialChange } from '../functions/lib/flaxia-auth-credentials.ts';
import { deletionOperationHash } from '../functions/lib/flaxia-auth-deletion.ts';

test('credential and Vault transition resumes after remote response loss and local rollback', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT, srp_salt TEXT, srp_verifier TEXT, srp_group TEXT, srp_kdf TEXT, frozen_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE flaxia_auth_sessions (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, grant_token TEXT, auth_stamp TEXT, source_stamp TEXT);
    CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY REFERENCES users(id), salt TEXT, kdf_params TEXT, wrapped_vk TEXT, vk_version INTEGER, updated_at TEXT);
    INSERT INTO users VALUES ('u', 'name', 'Name', '', 'old-salt', 'old-verifier', '2048', 'pbkdf2-600k-v2', NULL);
    INSERT INTO sessions VALUES ('session', 'u');
    INSERT INTO flaxia_auth_sessions VALUES ('session', '${'B'.repeat(43)}', 'old-stamp', 'old-stamp');
    INSERT INTO vault_keys VALUES ('u', 'old-vault-salt', '{}', 'old-wrapped', 1, '');`);
  for (const migration of [
    '0114_auth_provision_guard.sql',
    '0115_auth_deletion_jobs.sql',
    '0116_auth_link_guard.sql',
    '0117_auth_credential_jobs.sql',
    '0118_auth_credential_recovery.sql',
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const operation = 'A'.repeat(43),
    grant = 'B'.repeat(43);
  const hash = await deletionOperationHash(operation);
  assert.ok(hash);
  const target = await credentialStampFor({
    password_hash: '',
    srp_salt: 'new-salt',
    srp_verifier: 'new-verifier',
    srp_group: '2048',
    srp_kdf: 'pbkdf2-600k-v2',
  });
  assert.ok(target);
  const vault = JSON.stringify({ salt: 'new-vault-salt', kdf_params: {}, wrapped_vk: 'new-wrapped', vk_version: 1 });
  db.prepare(
    `INSERT INTO flaxia_auth_credential_jobs (operation_hash, user_id, session_id, grant_token, proof_json, old_password_hash, old_salt, old_verifier, old_group, old_kdf, new_salt, new_verifier, new_group, new_kdf, target_stamp, vault_json, state) VALUES (?, 'u', 'session', ?, '{}', '', 'old-salt', 'old-verifier', '2048', 'pbkdf2-600k-v2', 'new-salt', 'new-verifier', '2048', 'pbkdf2-600k-v2', ?, ?, 'pending')`,
  ).run(hash, grant, target.stamp, vault);
  type Bound = {
    sql: string;
    args: unknown[];
    run: () => { success: boolean; meta: { changes: number } };
    first: () => unknown;
  };
  let failBatch = true;
  const d1 = {
    prepare(sql: string) {
      const make = (...args: unknown[]): Bound => ({
        sql,
        args,
        run: () => ({
          success: true,
          meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) },
        }),
        first: () => db.prepare(sql).get(...(args as never[])) ?? null,
      });
      return { ...make(), bind: make };
    },
    async batch(statements: Bound[]) {
      db.exec('BEGIN');
      try {
        for (let i = 0; i < statements.length; i++) {
          if (failBatch && i === 4) {
            failBatch = false;
            throw new Error('injected local failure');
          }
          statements[i].run();
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let prepares = 0,
    commits = 0;
  const service = {
    async fetch(request: Request) {
      const body = (await request.json()) as { operation: string };
      assert.equal(body.operation, operation);
      if (new URL(request.url).pathname.endsWith('/prepare')) {
        if (++prepares === 1) throw new Error('prepared remotely, response lost');
      } else if (++commits === 1) throw new Error('committed remotely, response lost');
      return Response.json({ success: true, target_stamp: target.stamp });
    },
  };
  const env = { DB: d1, AUTH_SERVICE: service } as unknown as Env;
  assert.equal(await resumeAuthCredentialChange(env, operation), 'unavailable');
  assert.equal(await resumeAuthCredentialChange(env, operation), 'unavailable');
  assert.equal(db.prepare("SELECT srp_salt FROM users WHERE id = 'u'").get()?.srp_salt, 'old-salt');
  assert.equal(db.prepare("SELECT wrapped_vk FROM vault_keys WHERE user_id = 'u'").get()?.wrapped_vk, 'old-wrapped');
  assert.equal(await resumeAuthCredentialChange(env, operation), 'unavailable');
  assert.equal(db.prepare("SELECT srp_salt FROM users WHERE id = 'u'").get()?.srp_salt, 'new-salt');
  assert.equal(db.prepare("SELECT wrapped_vk FROM vault_keys WHERE user_id = 'u'").get()?.wrapped_vk, 'new-wrapped');
  assert.equal(await resumeAuthCredentialChange(env, operation), 'ok');
  assert.equal(await resumeAuthCredentialChange(env, operation), 'ok');
  assert.equal(prepares, 2);
  assert.equal(commits, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM flaxia_auth_transition_assertions').get()?.n, 0);
  db.close();
});
