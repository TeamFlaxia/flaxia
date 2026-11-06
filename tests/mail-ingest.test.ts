// Inbound pipeline regression: the raw MIME must be encrypted with the
// per-message content key before it is persisted, and the persisted ciphertext
// must be decryptable with the wrapped key the Worker stored for the recipient.
// This also pins client/worker ECIES byte compatibility (docs/mail.md §6.2).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleInboundEmail, type MailEnv } from '../mail-worker/src/ingest.ts';
import { decryptPayload, encodeB64, unwrapContentKey } from '../src/lib/mail/crypto.ts';

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
    if (sql.includes('FROM mail_identities')) return { public_key: spkiB64 };
    if (sql.includes('FROM mail_usage')) return null;
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
  } as unknown as MailEnv;

  return { env, written, puts };
}

describe('mail inbound ingest', () => {
  it('stores ciphertext and a decryptable wrapped content key', async () => {
    const recipient = await makeRecipient();
    const rawText = 'From: sender@example.com\r\nSubject: hello\r\n\r\nbody';
    const raw = new TextEncoder().encode(rawText).buffer;
    const { env, written, puts } = fakeEnv(recipient.spkiB64, { user_id: 'user-1', state: 'active' });

    await handleInboundEmail(env, raw, 'Alice@Flaxia.App');

    assert.equal(puts.length, 1, 'one payload object is written');
    const stored = puts[0].value;
    assert.notDeepEqual(Array.from(stored), Array.from(new Uint8Array(raw)), 'payload must not be stored as plaintext');

    const thread = written.find((statement) => statement.sql.includes('INSERT INTO mail_threads'));
    assert.ok(thread, 'the message thread row must be created for the FK');
    assert.equal(thread.params[1], 'user-1');

    const message = written.find((statement) => statement.sql.includes('INSERT INTO mail_messages'));
    assert.ok(message, 'message row is inserted');
    const messageId = message.params[0] as string;
    const payloadIv = message.params[6] as string;
    assert.ok(payloadIv, 'payload IV is persisted with the message');

    const keys = written.find((statement) => statement.sql.includes('INSERT INTO mail_message_keys'));
    assert.ok(keys, 'wrapped content key row is inserted');

    const contentKey = await unwrapContentKey(
      {
        ephemeralPublicKey: keys.params[2] as string,
        iv: keys.params[3] as string,
        wrappedContentKey: keys.params[4] as string,
      },
      recipient.pkcs8B64,
      messageId,
      'alice@flaxia.app',
    );
    const plaintext = await decryptPayload(contentKey, payloadIv, stored, messageId);
    assert.equal(new TextDecoder().decode(plaintext), rawText);
  });

  it('rejects an unknown recipient with a 550 code', async () => {
    const recipient = await makeRecipient();
    const { env } = fakeEnv(recipient.spkiB64, null);

    await assert.rejects(
      handleInboundEmail(env, new ArrayBuffer(8), 'nobody@flaxia.app'),
      (err: { code?: number }) => err.code === 550,
    );
  });
});
