// A D1-compatible adapter over node:sqlite.
//
// The ActivityPub handlers talk to D1 through the small API surface D1
// offers (`prepare`, `bind`, `first`, `all`, `run`, `batch`). Running them
// against a real SQLite database with the real migrations keeps the tests
// honest: a query that is wrong for the production schema fails here too.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../../functions/lib/activitypub/crypto.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface TestStatement {
  bind(...values: unknown[]): TestStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
}

export interface TestDatabase {
  prepare(sql: string): TestStatement;
  batch(statements: TestStatement[]): Promise<unknown[]>;
  exec(sql: string): void;
  close(): void;
}

type SqlValue = null | number | bigint | string | Uint8Array;

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

function makeStatement(db: DatabaseSync, sql: string, values: SqlValue[]): TestStatement {
  const statement = db.prepare(sql);
  return {
    bind(...next: unknown[]) {
      return makeStatement(db, sql, [...values, ...next.map(normalize)]);
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      const row = statement.get(...values);
      return (row as T | undefined) ?? null;
    },
    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
      return { results: statement.all(...values) as T[] };
    },
    async run() {
      const result = statement.run(...values);
      return {
        success: true,
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    },
  };
}

/** Apply every D1 migration to a fresh in-memory database. */
export function createTestDatabase(): TestDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const migrationDir = join(ROOT, 'migrations');
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'));
  }

  return {
    prepare(sql: string) {
      return makeStatement(db, sql, []);
    },
    async batch(statements: TestStatement[]) {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    exec(sql: string) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

/** Create a local account with an actor key pair. */
export async function seedLocalUser(
  db: TestDatabase,
  options: { id: string; username: string; displayName?: string; publicKeyPem?: string; privateKeyPem?: string },
): Promise<void> {
  // The key has to be a real one: the instance signs its requests to a
  // remote instance with it.
  const pair = await generateKeyPair();
  const publicKeyPem = options.publicKeyPem ?? (await exportPublicKey(pair.publicKey));
  const privateKeyPem = options.privateKeyPem ?? (await exportPrivateKey(pair.privateKey));
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
       VALUES (?, ?, '', ?, ?, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(options.id, `${options.id}@test.com`, options.username, options.displayName ?? options.username)
    .run();

  await db
    .prepare('INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem) VALUES (?, ?, ?)')
    .bind(options.id, publicKeyPem, privateKeyPem)
    .run();
}
