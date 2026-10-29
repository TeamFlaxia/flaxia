import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { deletionOperationHash } from '../functions/lib/flaxia-auth-deletion.ts';
import { resumeDirectCredentialChange } from '../functions/lib/flaxia-direct-credentials.ts';

test('direct credential change keeps only encrypted Vault data and resumes a lost commit response', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, frozen_at TEXT); INSERT INTO users VALUES ('u', NULL);
    CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY, salt TEXT, kdf_params TEXT, wrapped_vk TEXT, vk_version INTEGER, updated_at TEXT);
    INSERT INTO vault_keys VALUES ('u', 'old', '{}', 'old-wrap', 1, '');
    CREATE TABLE flaxia_auth_transition_assertions (valid INTEGER NOT NULL CHECK (valid = 1));`);
  db.exec(readFileSync(new URL('../migrations/0119_direct_auth_vault_changes.sql', import.meta.url), 'utf8'));
  const operation = 'A'.repeat(43),
    grant = 'B'.repeat(43),
    target = 'target-stamp';
  const hash = await deletionOperationHash(operation);
  const vault = JSON.stringify({ salt: 'new', kdf_params: {}, wrapped_vk: 'new-wrap', vk_version: 1 });
  db.prepare("INSERT INTO flaxia_direct_vault_changes VALUES (?, 'u', ?, ?, 'pending')").run(hash, target, vault);
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
        for (const statement of statements) statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let commits = 0;
  const service = {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/status')) return Response.json({ state: 'prepared', target_stamp: target });
      if (path.endsWith('/commit') && ++commits === 1) throw new Error('response lost');
      return Response.json({ success: true, target_stamp: target });
    },
  };
  const env = { DB: d1, AUTH_SERVICE: service } as unknown as Env;
  assert.equal(await resumeDirectCredentialChange(env, operation, grant, 'u'), 'unavailable');
  assert.equal(db.prepare('SELECT wrapped_vk FROM vault_keys').get()?.wrapped_vk, 'new-wrap');
  assert.equal(await resumeDirectCredentialChange(env, operation, grant, 'u'), 'ok');
  assert.equal(await resumeDirectCredentialChange(env, operation, grant, 'u'), 'ok');
  assert.equal(commits, 2);
  const job = db.prepare('SELECT * FROM flaxia_direct_vault_changes').get();
  assert.equal(job?.vault_json, null);
  assert.equal(job?.target_stamp, '');
  assert.equal(
    Object.keys(job ?? {}).some((key) => /grant|verifier|proof/.test(key)),
    false,
  );
  db.close();
});
