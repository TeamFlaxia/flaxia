// Read API contract for the Mail Worker (docs/mail.md §8). Runs the actual
// worker against an in-memory SQLite D1 so list/detail/actions SQL is exercised.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { signMailInternal } from '../functions/lib/mail-service.ts';
import worker from '../mail-worker/src/index.ts';
import type { MailEnv } from '../mail-worker/src/ingest.ts';

const SECRET = 'read-api-test-secret';
const ADDRESS = 'preview@flaxia.app';
const USER = 'user-1';

function database(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of ['migrations/mail/0001_mail_schema.sql', 'migrations/mail/0002_mail_p2_read.sql']) {
    sqlite.exec(readFileSync(file, 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO mail_addresses (address, user_id, kind, state) VALUES ('${ADDRESS}', '${USER}', 'primary', 'active');
    INSERT INTO mail_identities (user_id, address, public_key, key_version) VALUES ('${USER}', '${ADDRESS}', 'spki', 1);
    INSERT INTO mail_threads (id, user_id, subject_enc, last_message_at, message_count, unread_count, folder, thread_key)
      VALUES ('thread-1', '${USER}', 'subject-enc', '2026-11-06T12:00:00.000Z', 2, 1, 'inbox', 'thread-key');
    INSERT INTO mail_messages
      (id, user_id, thread_id, direction, folder, from_addr, to_addr, from_name_enc, subject_enc, meta_enc,
       message_id_hash, in_reply_to_hash, references_hash, received_at, size_bytes, has_attachments,
       read_at, security, blob_id, payload_iv)
      VALUES
      ('msg-1', '${USER}', 'thread-1', 'inbound', 'inbox', 'alice@example.com', '${ADDRESS}', 'from-enc',
       'subject-enc', 'meta-1', 'hash-1', '', '', '2026-11-06T11:00:00.000Z', 10, 0,
       '2026-11-06T11:05:00.000Z', 'at_rest', 'blob-1', 'iv-1'),
      ('msg-2', '${USER}', 'thread-1', 'inbound', 'inbox', 'bob@example.com', '${ADDRESS}', 'from-enc',
       'subject-enc', 'meta-2', 'hash-2', 'hash-1', 'hash-1', '2026-11-06T12:00:00.000Z', 20, 0,
       NULL, 'at_rest', 'blob-2', 'iv-2');
    INSERT INTO mail_message_keys
      (message_id, recipient_address, key_version, ephemeral_public_key, iv, wrapped_content_key)
      VALUES ('msg-2', '${ADDRESS}', 1, 'eph', 'key-iv', 'wrapped');
    INSERT INTO mail_attachments (id, message_id, user_id, filename_enc, content_type, size_bytes, r2_key, scan_status)
      VALUES ('att-1', 'msg-2', '${USER}', 'name-enc', 'application/pdf', 3, 'att-key', 'pending');
    INSERT INTO mail_usage (user_id, storage_bytes) VALUES ('${USER}', 30);
  `);
  return sqlite;
}

function d1(sqlite: DatabaseSync): D1Database {
  function statement(sql: string, values: SQLInputValue[] = []) {
    return {
      bind(...bound: SQLInputValue[]) {
        return statement(sql, bound);
      },
      async first() {
        return sqlite.prepare(sql).get(...values) ?? null;
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...values) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      return Promise.all(statements.map((query) => query.run()));
    },
  } as unknown as D1Database;
}

function env(sqlite: DatabaseSync): MailEnv {
  return {
    MAIL_DB: d1(sqlite),
    MAIL_BUCKET: {
      async get(key: string) {
        const bytes = new TextEncoder().encode(`ciphertext:${key}`);
        return { body: new Response(bytes).body } as unknown as R2ObjectBody;
      },
    },
    MAIL_QUEUE: {},
    MAIL_QUEUE_DLQ: {},
    MAIL_INTERNAL_SECRET: SECRET,
  } as unknown as MailEnv;
}

async function signed(envValue: MailEnv, method: string, path: string, body?: string): Promise<Request> {
  const headers = await signMailInternal(envValue, USER, method, path, body ?? '');
  assert.ok(headers);
  return new Request(`https://flaxia-mail${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' ? { 'Idempotency-Key': 'read-api-test-key' } : {}),
    },
    ...(body ? { body } : {}),
  });
}

describe('mail read API', () => {
  it('lists threads with encrypted metadata and the latest wrapped key', async () => {
    const sqlite = database();
    const envValue = env(sqlite);
    const path = '/internal/threads?folder=inbox&limit=30';
    const response = await worker.fetch(await signed(envValue, 'GET', path), envValue);
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      threads: Array<{
        id: string;
        message_id: string;
        meta_enc: string;
        key: { wrapped_content_key: string; recipient_address: string } | null;
        unread_count: number;
        folder: string;
      }>;
      counts: Record<string, number>;
      next_cursor?: string;
    };
    assert.equal(body.threads.length, 1);
    assert.equal(body.threads[0]?.id, 'thread-1');
    assert.equal(body.threads[0]?.message_id, 'msg-2');
    assert.equal(body.threads[0]?.meta_enc, 'meta-2');
    assert.equal(body.threads[0]?.key?.recipient_address, ADDRESS);
    assert.equal(body.threads[0]?.unread_count, 1);
    assert.equal(body.counts.inbox, 1);
    sqlite.close();
  });

  it('returns thread messages and attachment metadata', async () => {
    const sqlite = database();
    const envValue = env(sqlite);
    const response = await worker.fetch(await signed(envValue, 'GET', '/internal/threads/thread-1'), envValue);
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      thread: { id: string };
      messages: Array<{ id: string; meta_enc: string; key: { wrapped_content_key: string } | null }>;
      attachments: Array<{ id: string; scan_status: string }>;
    };
    assert.equal(body.thread.id, 'thread-1');
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1]?.id, 'msg-2');
    assert.equal(body.messages[1]?.meta_enc, 'meta-2');
    assert.equal(body.messages[1]?.key?.wrapped_content_key, 'wrapped');
    assert.equal(body.attachments[0]?.id, 'att-1');
    sqlite.close();
  });

  it('marks a message read and refreshes the thread unread count', async () => {
    const sqlite = database();
    const envValue = env(sqlite);
    const payload = JSON.stringify({ action: 'read', ids: ['msg-2'] });
    const response = await worker.fetch(
      await signed(envValue, 'POST', '/internal/messages/actions', payload),
      envValue,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { updated: number };
    assert.equal(body.updated, 1);
    const message = sqlite.prepare('SELECT read_at FROM mail_messages WHERE id = ?').get('msg-2') as {
      read_at: string | null;
    };
    const thread = sqlite.prepare('SELECT unread_count FROM mail_threads WHERE id = ?').get('thread-1') as {
      unread_count: number;
    };
    assert.ok(message.read_at);
    assert.equal(thread.unread_count, 0);
    sqlite.close();
  });

  it('soft-deletes a message without violating the thread foreign key', async () => {
    const sqlite = database();
    const envValue = env(sqlite);
    const payload = JSON.stringify({ action: 'delete', ids: ['msg-2'] });
    const response = await worker.fetch(
      await signed(envValue, 'POST', '/internal/messages/actions', payload),
      envValue,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const message = sqlite.prepare('SELECT deleted_at FROM mail_messages WHERE id = ?').get('msg-2') as {
      deleted_at: string | null;
    };
    const thread = sqlite.prepare('SELECT id FROM mail_threads WHERE id = ?').get('thread-1');
    assert.ok(message.deleted_at);
    assert.ok(thread, 'the thread row survives while a soft-deleted message still references it');
    sqlite.close();
  });

  it('streams the encrypted payload and attachment bytes', async () => {
    const sqlite = database();
    const envValue = env(sqlite);
    const payload = await worker.fetch(await signed(envValue, 'GET', '/internal/messages/msg-2/payload'), envValue);
    assert.equal(payload.status, 200);
    assert.equal(await payload.text(), 'ciphertext:blob-2');
    const attachment = await worker.fetch(
      await signed(envValue, 'GET', '/internal/messages/msg-2/attachments/att-1'),
      envValue,
    );
    assert.equal(attachment.status, 200);
    assert.equal(await attachment.text(), 'ciphertext:att-key');
    sqlite.close();
  });

  it('stops serving attachment bytes after the parent message is soft-deleted', async () => {
    const sqlite = database();
    const envValue = env(sqlite);
    const payload = JSON.stringify({ action: 'delete', ids: ['msg-2'] });
    const response = await worker.fetch(
      await signed(envValue, 'POST', '/internal/messages/actions', payload),
      envValue,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const attachment = await worker.fetch(
      await signed(envValue, 'GET', '/internal/messages/msg-2/attachments/att-1'),
      envValue,
    );
    assert.equal(attachment.status, 404, 'a deleted message must not keep serving its attachments');
    const messagePayload = await worker.fetch(
      await signed(envValue, 'GET', '/internal/messages/msg-2/payload'),
      envValue,
    );
    assert.equal(messagePayload.status, 404);
    sqlite.close();
  });
});
