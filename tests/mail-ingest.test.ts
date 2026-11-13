// Inbound pipeline regression: MIME is parsed, metadata/payload are encrypted
// before persistence, and the wrapped content key lets the recipient decrypt
// both. This also pins client/worker crypto byte compatibility.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleInboundEmail, type MailEnv } from '../mail-worker/src/ingest.ts';
import {
  decryptPayload,
  decryptString,
  encodeB64,
  metaInfo,
  subjectInfo,
  unwrapContentKey,
} from '../src/lib/mail/crypto.ts';

interface Captured {
  sql: string;
  params: unknown[];
}

async function makeRecipient(): Promise<{ spkiB64: string; pkcs8B64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { spkiB64: encodeB64(spki), pkcs8B64: encodeB64(pkcs8) };
}

function fakeEnv(spkiB64: string, addressRow: { user_id: string; state: string } | null) {
  const written: Captured[] = [];
  const puts: Array<{ key: string; value: Uint8Array }> = [];

  const firstFor = (sql: string): unknown => {
    if (sql.includes('FROM mail_addresses')) return addressRow;
    if (sql.includes('FROM mail_identities')) return { public_key: spkiB64, key_version: 1 };
    if (sql.includes('FROM mail_usage')) return null;
    if (sql.includes('FROM mail_messages')) return null;
    if (sql.includes('FROM mail_threads')) return null;
    throw new Error(`unexpected query: ${sql}`);
  };

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            sql,
            params,
            first: async () => firstFor(sql),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
    async batch(statements: Captured[]) {
      written.push(...statements);
      return [];
    },
  };

  const bucket = {
    async put(key: string, value: Uint8Array) {
      puts.push({ key, value: new Uint8Array(value) });
      return {};
    },
  };

  const env = {
    MAIL_DB: db,
    MAIL_BUCKET: bucket,
    MAIL_QUEUE: {},
    MAIL_QUEUE_DLQ: {},
    MAIL_THREAD_SECRET: 'test-thread-secret',
  } as unknown as MailEnv;

  return { env, written, puts };
}

const RAW_EMAIL = [
  'From: Alice <alice@example.com>',
  'To: preview@flaxia.app',
  'Subject: Hello from the outside',
  'Message-ID: <message-1@example.com>',
  'Date: Wed, 05 Nov 2026 12:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello body',
].join('\r\n');

describe('mail inbound ingest', () => {
  it('encrypts metadata and payload and stores a decryptable content key', async () => {
    const recipient = await makeRecipient();
    const raw = new TextEncoder().encode(RAW_EMAIL).buffer;
    const { env, written, puts } = fakeEnv(recipient.spkiB64, { user_id: 'user-1', state: 'active' });

    await handleInboundEmail(env, raw, 'Preview@Flaxia.App', 'alice@example.com');

    assert.equal(puts.length, 1, 'one encrypted payload object is written');
    const stored = puts[0].value;
    assert.notDeepEqual(Array.from(stored), Array.from(new TextEncoder().encode(RAW_EMAIL)));

    const thread = written.find((statement) => statement.sql.includes('INSERT INTO mail_threads'));
    assert.ok(thread, 'the message thread row must be created');
    assert.equal(thread.params[1], 'user-1');

    const message = written.find((statement) => statement.sql.includes('INSERT INTO mail_messages'));
    assert.ok(message, 'message row is inserted');
    const messageId = message.params[0] as string;
    const fromAddr = message.params[4] as string;
    const subjectEnc = message.params[7] as string;
    const metaEnc = message.params[8] as string;
    const payloadIv = message.params[19] as string;
    assert.equal(fromAddr, 'alice@example.com');
    assert.ok(subjectEnc && metaEnc && payloadIv);

    const keys = written.find((statement) => statement.sql.includes('INSERT INTO mail_message_keys'));
    assert.ok(keys, 'wrapped content key row is inserted');
    assert.equal(keys.params[2], 1, 'the identity key version is persisted');

    const contentKey = await unwrapContentKey(
      {
        ephemeralPublicKey: keys.params[3] as string,
        iv: keys.params[4] as string,
        wrappedContentKey: keys.params[5] as string,
      },
      recipient.pkcs8B64,
      messageId,
      'preview@flaxia.app',
    );

    const meta = JSON.parse(await decryptString(contentKey, metaEnc, metaInfo(messageId))) as {
      subject: string;
      from_name: string;
      snippet: string;
    };
    assert.equal(meta.subject, 'Hello from the outside');
    assert.equal(meta.from_name, 'Alice');
    assert.match(meta.snippet, /Hello body/);
    assert.equal(await decryptString(contentKey, subjectEnc, subjectInfo(messageId)), 'Hello from the outside');

    const payload = JSON.parse(
      new TextDecoder().decode(await decryptPayload(contentKey, payloadIv, stored, messageId)),
    ) as { text: string };
    assert.equal(payload.text.trim(), 'Hello body');
  });

  it('rejects an unknown recipient with a 550 code', async () => {
    const recipient = await makeRecipient();
    const { env } = fakeEnv(recipient.spkiB64, null);

    await assert.rejects(
      handleInboundEmail(env, new TextEncoder().encode(RAW_EMAIL).buffer, 'nobody@flaxia.app'),
      (err: { code?: number }) => err.code === 550,
    );
  });
});
