// External TLS send (docs/mail.md §9.2) against an in-memory D1. The retained
// Sent copy is sealed with the production sealer (sender-only wrap); the
// Worker must deliver plaintext through the mocked send_email binding and
// store only the sealed Sent copy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { signMailInternal } from '../functions/lib/mail-service.ts';
import worker from '../mail-worker/src/index.ts';
import type { MailEnv } from '../mail-worker/src/ingest.ts';
import { decryptPayload, decryptString, metaInfo, unwrapContentKey } from '../src/lib/mail/crypto.ts';
import { type ComposeFields, type RecipientKey, sealEnvelope } from '../src/lib/mail/seal.ts';

const SECRET = 'external-test-secret';
const DOMAIN = 'flaxia.app';
const MIGRATIONS = [
  'migrations/mail/0001_mail_schema.sql',
  'migrations/mail/0002_mail_p2_read.sql',
  'migrations/mail/0003_mail_p3_send.sql',
];

interface Identity {
  id: string;
  address: string;
  spki: string;
  pkcs8: string;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function makeIdentity(id: string, local: string): Promise<Identity> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { id, address: `${local}@${DOMAIN}`, spki: b64(spki), pkcs8: b64(pkcs8) };
}

interface SentMail {
  from: unknown;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  subject: unknown;
  text: unknown;
  attachments: unknown;
  headers?: unknown;
}

function database(alice: Identity): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, 'utf8'));
  sqlite
    .prepare('INSERT INTO mail_addresses (address, user_id, kind, state) VALUES (?, ?, ?, ?)')
    .run(alice.address, alice.id, 'primary', 'active');
  sqlite
    .prepare('INSERT INTO mail_identities (user_id, address, public_key, key_version) VALUES (?, ?, ?, ?)')
    .run(alice.id, alice.address, alice.spki, 1);
  sqlite.prepare('INSERT INTO mail_usage (user_id, storage_bytes) VALUES (?, 0)').run(alice.id);
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

function env(
  sqlite: DatabaseSync,
  send: (message: SentMail) => Promise<void> = async () => {},
): { env: MailEnv; sent: SentMail[]; bucket: Map<string, Uint8Array> } {
  const bucket = new Map<string, Uint8Array>();
  const sent: SentMail[] = [];
  const value = {
    MAIL_DB: d1(sqlite),
    MAIL_BUCKET: {
      async put(key: string, bytes: Uint8Array) {
        bucket.set(key, new Uint8Array(bytes));
      },
      async get(key: string) {
        const bytes = bucket.get(key);
        if (!bytes) return null;
        return { body: new Response(bytes as BodyInit).body };
      },
      async delete(key: string) {
        bucket.delete(key);
      },
    },
    MAIL_QUEUE: {},
    MAIL_QUEUE_DLQ: {},
    MAIL_SEND: {
      async send(message: SentMail) {
        sent.push(message);
        await send(message);
        return { messageId: 'provider-1' };
      },
    },
    MAIL_INTERNAL_SECRET: SECRET,
    MAIL_DOMAIN: DOMAIN,
  } as unknown as MailEnv;
  return { env: value, sent, bucket };
}

async function postExternal(
  envValue: MailEnv,
  sender: Identity,
  body: Record<string, unknown>,
  key = `ext-key-${crypto.randomUUID().slice(0, 8)}`,
): Promise<Response> {
  const serialized = JSON.stringify(body);
  const headers = await signMailInternal(envValue, sender.id, 'POST', '/internal/external-send', serialized);
  assert.ok(headers);
  const req = new Request('https://flaxia-mail/internal/external-send', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: serialized,
  });
  return worker.fetch(req, envValue);
}

function keyOf(identity: Identity): RecipientKey {
  return { address: identity.address, public_key: identity.spki, key_version: 1 };
}

function fields(partial: Partial<ComposeFields> = {}): ComposeFields {
  return {
    from: 'alice@flaxia.app',
    to: ['friend@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello outside',
    text: 'Plain body',
    attachments: [],
    ...partial,
  };
}

async function retained(
  alice: Identity,
  compose: ComposeFields,
  context: { threadId?: string; inReplyToHash?: string } = {},
) {
  return sealEnvelope(compose, [keyOf(alice)], { fromName: 'Alice', ...context }, { wrapAddresses: [alice.address] });
}

describe('external TLS send', () => {
  it('delivers plaintext via send_email and stores a sealed Sent copy', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const sqlite = database(alice);
    const { env: envValue, sent, bucket } = env(sqlite);
    const compose = fields({
      attachments: [{ name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('notes') }],
    });
    const sealed = await retained(alice, compose);
    const response = await postExternal(envValue, alice, {
      message_id: sealed.message_id,
      from: compose.from,
      from_name: 'Alice',
      to: compose.to,
      cc: [],
      bcc: [],
      subject: compose.subject,
      text: compose.text,
      attachments: [
        { filename: 'notes.txt', content_type: 'text/plain', data_b64: b64(new TextEncoder().encode('notes')) },
      ],
      retained: sealed,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as { ok: boolean; delivered: number };
    assert.equal(result.delivered, 1);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.to, ['friend@example.com']);
    assert.equal(sent[0]?.subject, 'Hello outside');
    assert.equal(sent[0]?.text, 'Plain body');
    const attachments = sent[0]?.attachments as Array<{ filename: string; type: string; content: Uint8Array }>;
    assert.equal(attachments[0]?.filename, 'notes.txt');
    assert.deepEqual(new TextDecoder().decode(attachments[0]?.content), 'notes');

    const row = sqlite
      .prepare("SELECT * FROM mail_messages WHERE user_id = ? AND folder = 'sent'")
      .get(alice.id) as Record<string, unknown>;
    assert.equal(row.direction, 'outbound');
    assert.equal(row.security, 'tls');
    assert.equal(row.aad_id, sealed.message_id);
    const keyRow = sqlite
      .prepare('SELECT * FROM mail_message_keys WHERE message_id = ? AND recipient_address = ?')
      .get(row.id, alice.address) as Record<string, unknown>;
    assert.ok(keyRow?.wrapped_content_key);
    const contentKey = await unwrapContentKey(
      {
        ephemeralPublicKey: String(keyRow.ephemeral_public_key),
        iv: String(keyRow.iv),
        wrappedContentKey: String(keyRow.wrapped_content_key),
      },
      alice.pkcs8,
      String(row.aad_id),
      alice.address,
    );
    const plaintext = await decryptPayload(
      contentKey,
      String(row.payload_iv),
      bucket.get(String(row.blob_id)) as Uint8Array,
      String(row.aad_id),
    );
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), { text: 'Plain body' });
    const meta = JSON.parse(await decryptString(contentKey, String(row.meta_enc), metaInfo(String(row.aad_id)))) as {
      subject: string;
      to: string[];
    };
    assert.equal(meta.subject, 'Hello outside');
    assert.deepEqual(meta.to, ['friend@example.com']);
    contentKey.fill(0);

    const job = sqlite.prepare('SELECT * FROM mail_outbound_jobs WHERE user_id = ?').get(alice.id) as Record<
      string,
      unknown
    >;
    assert.equal(job.state, 'sent');
    assert.equal(job.provider_message_id, 'provider-1');
    const usage = sqlite
      .prepare('SELECT external_sends, external_day FROM mail_usage WHERE user_id = ?')
      .get(alice.id) as {
      external_sends: number;
      external_day: string;
    };
    assert.equal(Number(usage.external_sends), 1);
    assert.ok(usage.external_day.length > 0);
    sqlite.close();
  });

  it('threads an external reply onto the Sent thread', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const sqlite = database(alice);
    const { env: envValue } = env(sqlite);
    const first = await retained(alice, fields());
    const firstResponse = await postExternal(envValue, alice, {
      message_id: first.message_id,
      from: fields().from,
      from_name: 'Alice',
      to: ['friend@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello outside',
      text: 'Plain body',
      attachments: [],
      retained: first,
    });
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    const thread = sqlite.prepare('SELECT id FROM mail_threads WHERE user_id = ?').get(alice.id) as { id: string };
    const parent = sqlite.prepare('SELECT message_id_hash FROM mail_messages WHERE user_id = ?').get(alice.id) as {
      message_id_hash: string;
    };

    const replyFields = fields({ subject: 'Re: Hello outside', text: 'Follow-up' });
    const reply = await retained(alice, replyFields, { threadId: thread.id, inReplyToHash: parent.message_id_hash });
    const replyResponse = await postExternal(envValue, alice, {
      message_id: reply.message_id,
      thread_id: thread.id,
      in_reply_to_hash: parent.message_id_hash,
      from: replyFields.from,
      from_name: 'Alice',
      to: replyFields.to,
      cc: [],
      bcc: [],
      subject: replyFields.subject,
      text: replyFields.text,
      attachments: [],
      retained: reply,
    });
    assert.equal(replyResponse.status, 200, await replyResponse.clone().text());
    const after = sqlite.prepare('SELECT message_count FROM mail_threads WHERE id = ?').get(thread.id) as {
      message_count: number;
    };
    assert.equal(Number(after.message_count), 2);
    const usage = sqlite.prepare('SELECT external_sends FROM mail_usage WHERE user_id = ?').get(alice.id) as {
      external_sends: number;
    };
    assert.equal(Number(usage.external_sends), 2);
    sqlite.close();
  });

  it('rejects header injection, all-internal bodies, and send failures', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const sqlite = database(alice);
    const { env: envValue } = env(sqlite);
    const sealed = await retained(alice, fields());

    const injected = await postExternal(envValue, alice, {
      message_id: sealed.message_id,
      from: fields().from,
      from_name: 'Alice',
      to: ['friend@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello\nInjected: yes',
      text: 'Plain body',
      attachments: [],
      retained: sealed,
    });
    assert.equal(injected.status, 400);
    assert.equal(((await injected.json()) as { error: string }).error, 'mail_header_injection');

    const internalFields = fields({ to: ['bob@flaxia.app'] });
    const internalSealed = await retained(alice, internalFields);
    const internal = await postExternal(envValue, alice, {
      message_id: internalSealed.message_id,
      from: internalFields.from,
      from_name: 'Alice',
      to: internalFields.to,
      cc: [],
      bcc: [],
      subject: internalFields.subject,
      text: internalFields.text,
      attachments: [],
      retained: internalSealed,
    });
    assert.equal(internal.status, 422);
    assert.equal(((await internal.json()) as { error: string }).error, 'mail_external_unavailable');

    const failing = database(alice);
    const { env: failingEnv } = env(failing, async () => {
      throw new Error('provider down');
    });
    const failingSealed = await retained(alice, fields());
    const failed = await postExternal(failingEnv, alice, {
      message_id: failingSealed.message_id,
      from: fields().from,
      from_name: 'Alice',
      to: ['friend@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello outside',
      text: 'Plain body',
      attachments: [],
      retained: failingSealed,
    });
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as { error: string }).error, 'mail_send_failed');
    const sentCount = failing.prepare('SELECT COUNT(*) AS count FROM mail_messages').get() as { count: number };
    assert.equal(Number(sentCount.count), 0);
    failing.close();
    sqlite.close();
  });

  it('enforces the daily external send quota', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const sqlite = database(alice);
    const today = new Date().toISOString().slice(0, 10);
    sqlite
      .prepare('UPDATE mail_usage SET external_sends = 20, external_day = ? WHERE user_id = ?')
      .run(today, alice.id);
    const { env: envValue } = env(sqlite);
    const sealed = await retained(alice, fields());
    const response = await postExternal(envValue, alice, {
      message_id: sealed.message_id,
      from: fields().from,
      from_name: 'Alice',
      to: ['friend@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello outside',
      text: 'Plain body',
      attachments: [],
      retained: sealed,
    });
    assert.equal(response.status, 429);
    assert.equal(((await response.json()) as { error: string }).error, 'mail_rate_limited');
    sqlite.close();
  });
});
