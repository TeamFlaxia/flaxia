import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('pending provisioning prevents credential changes and deletion until a coordinated flow exists', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT, srp_salt TEXT, srp_verifier TEXT, srp_group TEXT, srp_kdf TEXT);
    INSERT INTO users VALUES ('u', 'name', 'Name', '', 'salt', 'verifier', '2048', 'pbkdf2-600k-v2');`);
  db.exec(readFileSync(new URL('../migrations/0115_auth_provision_guard.sql', import.meta.url), 'utf8'));
  db.exec(
    `INSERT INTO flaxia_auth_provisioning SELECT id, username, display_name, srp_salt, srp_verifier, srp_group, srp_kdf FROM users WHERE id = 'u'`,
  );
  assert.throws(() => db.exec("UPDATE users SET srp_verifier = 'changed' WHERE id = 'u'"), /auth_provisioning_guard/);
  assert.throws(() => db.exec("DELETE FROM users WHERE id = 'u'"), /auth_provisioning_guard/);
  db.exec("UPDATE users SET display_name = 'Changed' WHERE id = 'u'");
  assert.equal(
    db.prepare("SELECT display_name FROM flaxia_auth_provisioning WHERE user_id = 'u'").get()?.display_name,
    'Name',
  );
  db.close();
});

test('link guard survives session deletion and stops local credential mutation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT, srp_salt TEXT, srp_verifier TEXT, srp_group TEXT, srp_kdf TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE flaxia_auth_sessions (session_id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('u', '', 'salt', 'verifier', '2048', 'pbkdf2-600k-v2');
    INSERT INTO sessions VALUES ('s', 'u'); INSERT INTO flaxia_auth_sessions VALUES ('s');`);
  db.exec(readFileSync(new URL('../migrations/0117_auth_link_guard.sql', import.meta.url), 'utf8'));
  db.exec("DELETE FROM flaxia_auth_sessions WHERE session_id = 's'; DELETE FROM sessions WHERE id = 's'");
  assert.throws(() => db.exec("UPDATE users SET srp_verifier = 'changed' WHERE id = 'u'"), /auth_link_guard/);
  assert.throws(() => db.exec("DELETE FROM users WHERE id = 'u'"), /auth_link_guard/);
  db.close();
});
