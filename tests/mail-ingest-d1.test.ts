// Full inbound pipeline against an in-memory SQLite D1. This catches column,
// bind-order and transaction mistakes that the fake-statement unit test cannot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { handleInboundEmail, type MailEnv } from '../mail-worker/src/ingest.ts';
import { decryptPayload, decryptString, encodeB64, metaInfo, unwrapContentKey } from '../src/lib/mail/crypto.ts';

const ADDRESS = 'preview@flaxia.app';
const USER = 'user-1';
const SECRET = 'ingest-d1-thread-secret';

function database(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of [
    'migrations/mail/0001_mail_schema.sql',
    'migrations/mail/0002_mail_p2_read.sql',
    'migrations/mail/0003_mail_p3_send.sql',
  ]) {
    sqlite.exec(readFileSync(file, 'utf8'));
  }
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

function env(sqlite: DatabaseSync, spkiB64: string) {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array) {
      objects.set(key, new Uint8Array(value));
      return {};
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? ({ body: new Response(value).body } as unknown as R2ObjectBody) : null;
    },
  };
  const envValue = {
    MAIL_DB: d1(sqlite),
    MAIL_BUCKET: bucket,
    MAIL_QUEUE: {},
    MAIL_QUEUE_DLQ: {},
    MAIL_THREAD_SECRET: SECRET,
  } as unknown as MailEnv;
  return { env: envValue, objects };
}

async function recipient(): Promise<{ spkiB64: string; pkcs8B64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { spkiB64: encodeB64(spki), pkcs8B64: encodeB64(pkcs8) };
}

function bootstrap(sqlite: DatabaseSync, spkiB64: string): void {
  sqlite
    .prepare('INSERT INTO mail_addresses (address, user_id, kind, state) VALUES (?, ?, ?, ?)')
    .run(ADDRESS, USER, 'primary', 'active');
  sqlite
    .prepare('INSERT INTO mail_identities (user_id, address, public_key, key_version) VALUES (?, ?, ?, ?)')
    .run(USER, ADDRESS, spkiB64, 1);
}

function rawEmail(headers: string[], body: string): ArrayBuffer {
  return new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n${body}`).buffer;
}

describe('mail ingest with a real D1 schema', () => {
  it('parses, encrypts and threads a plain text message', async () => {
    const sqlite = database();
    const keys = await recipient();
    bootstrap(sqlite, keys.spkiB64);
    const { env: envValue, objects } = env(sqlite, keys.spkiB64);
    const raw = rawEmail(
      [
        'From: Alice <alice@example.com>',
        'To: preview@flaxia.app',
        'Subject: Hello',
        'Message-ID: <message-1@example.com>',
        'Authentication-Results: mx.cloudflare.net; spf=pass dkim=pass dmarc=pass',
        'Content-Type: text/plain; charset=utf-8',
      ],
      'Hello body',
    );
    await handleInboundEmail(envValue, raw, ADDRESS, 'alice@example.com');

    const message = sqlite.prepare('SELECT * FROM mail_messages').get() as Record<string, unknown>;
    const thread = sqlite.prepare('SELECT * FROM mail_threads').get() as Record<string, unknown>;
    const key = sqlite.prepare('SELECT * FROM mail_message_keys').get() as Record<string, unknown>;
    assert.equal(message.user_id, USER);
    assert.equal(message.folder, 'inbox');
    assert.equal(message.security, 'at_rest');
    assert.equal(thread.id, message.thread_id);
    assert.equal(thread.folder, 'inbox');
    assert.equal(thread.message_count, 1);
    assert.equal(thread.unread_count, 1);
    assert.ok(thread.thread_key);
    assert.equal(key.recipient_address, ADDRESS);

    const contentKey = await unwrapContentKey(
      {
        ephemeralPublicKey: key.ephemeral_public_key as string,
        iv: key.iv as string,
        wrappedContentKey: key.wrapped_content_key as string,
      },
      keys.pkcs8B64,
      message.id as string,
      ADDRESS,
    );
    const meta = JSON.parse(
      await decryptString(contentKey, message.meta_enc as string, metaInfo(message.id as string)),
    ) as { subject: string; from_name: string };
    assert.equal(meta.subject, 'Hello');
    assert.equal(meta.from_name, 'Alice');
    const blob = objects.get(message.blob_id as string);
    assert.ok(blob);
    const payload = JSON.parse(
      new TextDecoder().decode(
        await decryptPayload(contentKey, message.payload_iv as string, blob, message.id as string),
      ),
    ) as { text: string };
    assert.match(payload.text, /Hello body/);
    sqlite.close();
  });

  it('merges a reply into the existing thread via Message-ID hashes', async () => {
    const sqlite = database();
    const keys = await recipient();
    bootstrap(sqlite, keys.spkiB64);
    const { env: envValue } = env(sqlite, keys.spkiB64);
    await handleInboundEmail(
      envValue,
      rawEmail(
        [
          'From: Alice <alice@example.com>',
          'To: preview@flaxia.app',
          'Subject: Hello',
          'Message-ID: <message-1@example.com>',
          'Content-Type: text/plain; charset=utf-8',
        ],
        'First',
      ),
      ADDRESS,
      'alice@example.com',
    );
    await handleInboundEmail(
      envValue,
      rawEmail(
        [
          'From: Alice <alice@example.com>',
          'To: preview@flaxia.app',
          'Subject: Re: Hello',
          'Message-ID: <message-2@example.com>',
          'In-Reply-To: <message-1@example.com>',
          'References: <message-1@example.com>',
          'Content-Type: text/plain; charset=utf-8',
        ],
        'Second',
      ),
      ADDRESS,
      'alice@example.com',
    );

    const threads = sqlite.prepare('SELECT * FROM mail_threads').all() as Array<Record<string, unknown>>;
    const messages = sqlite.prepare('SELECT * FROM mail_messages').all() as Array<Record<string, unknown>>;
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.message_count, 2);
    assert.equal(threads[0]?.unread_count, 2);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.thread_id, messages[1]?.thread_id);
    sqlite.close();
  });

  it('stores a safe attachment encrypted and quarantines it until scanning', async () => {
    const sqlite = database();
    const keys = await recipient();
    bootstrap(sqlite, keys.spkiB64);
    const { env: envValue, objects } = env(sqlite, keys.spkiB64);
    const body = [
      '--boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See attached',
      '--boundary',
      'Content-Type: application/pdf; name="guide.pdf"',
      'Content-Disposition: attachment; filename="guide.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0=',
      '--boundary--',
    ].join('\r\n');
    await handleInboundEmail(
      envValue,
      rawEmail(
        [
          'From: Alice <alice@example.com>',
          'To: preview@flaxia.app',
          'Subject: PDF',
          'Message-ID: <message-pdf@example.com>',
          'Content-Type: multipart/mixed; boundary="boundary"',
        ],
        body,
      ),
      ADDRESS,
      'alice@example.com',
    );

    const message = sqlite.prepare('SELECT * FROM mail_messages').get() as Record<string, unknown>;
    const attachment = sqlite.prepare('SELECT * FROM mail_attachments').get() as Record<string, unknown>;
    assert.equal(message.folder, 'spam', 'non-inline attachments are quarantined until scanning exists');
    assert.equal(message.has_attachments, 1);
    assert.equal(attachment.content_type, 'application/pdf');
    assert.equal(attachment.scan_status, 'pending');
    assert.ok(attachment.r2_key);
    const stored = objects.get(attachment.r2_key as string);
    assert.ok(stored);
    assert.notEqual(new TextDecoder().decode(stored), 'JVBERi0=');
    sqlite.close();
  });
});
