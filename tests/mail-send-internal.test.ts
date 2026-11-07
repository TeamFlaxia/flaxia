// Internal E2EE send + encrypted drafts, end-to-end against an in-memory D1.
// The envelope is sealed exactly like the client (mail-send-seal.test.ts covers
// the production sealer); here we exercise fan-out, Sent copies, threading,
// idempotency, quotas, and draft CRUD in the real Worker handlers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { signMailInternal } from '../functions/lib/mail-service.ts';
import {
  attachmentKeyInfo,
  deriveAttachmentKey,
  encryptBytes,
  encryptPayload,
  encryptString,
  fromNameInfo,
  metaInfo,
  subjectInfo,
  wrapContentKey,
} from '../mail-worker/src/crypto.ts';
import worker from '../mail-worker/src/index.ts';
import type { MailEnv } from '../mail-worker/src/ingest.ts';
import { decryptPayload, decryptString, unwrapContentKey } from '../src/lib/mail/crypto.ts';

const SECRET = 'send-test-secret';
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

interface Bucket {
  objects: Map<string, Uint8Array>;
}

function database(alice: Identity, bob: Identity): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, 'utf8'));
  for (const identity of [alice, bob]) {
    sqlite
      .prepare('INSERT INTO mail_addresses (address, user_id, kind, state) VALUES (?, ?, ?, ?)')
      .run(identity.address, identity.id, 'primary', 'active');
    sqlite
      .prepare('INSERT INTO mail_identities (user_id, address, public_key, key_version) VALUES (?, ?, ?, ?)')
      .run(identity.id, identity.address, identity.spki, 1);
    sqlite.prepare('INSERT INTO mail_usage (user_id, storage_bytes) VALUES (?, 0)').run(identity.id);
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

function env(sqlite: DatabaseSync): { env: MailEnv; bucket: Bucket } {
  const bucket: Bucket = { objects: new Map() };
  const value = {
    MAIL_DB: d1(sqlite),
    MAIL_BUCKET: {
      async put(key: string, bytes: Uint8Array) {
        bucket.objects.set(key, new Uint8Array(bytes));
      },
      async get(key: string) {
        const bytes = bucket.objects.get(key);
        if (!bytes) return null;
        return { body: new Response(bytes as BodyInit).body };
      },
      async delete(key: string) {
        bucket.objects.delete(key);
      },
    },
    MAIL_QUEUE: {},
    MAIL_QUEUE_DLQ: {},
    MAIL_INTERNAL_SECRET: SECRET,
    MAIL_DOMAIN: DOMAIN,
  } as unknown as MailEnv;
  return { env: value, bucket };
}

async function signed(
  envValue: MailEnv,
  userId: string,
  method: string,
  path: string,
  body?: string,
  key = 'send-test-key-0001',
): Promise<Request> {
  const headers = await signMailInternal(envValue, userId, method, path, body ?? '');
  assert.ok(headers);
  return new Request(`https://flaxia-mail${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body } : {}),
  });
}

interface SealOptions {
  from: Identity;
  sender: Identity;
  recipients: Identity[];
  subject?: string;
  text?: string;
  attachments?: Array<{ name: string; type: string; bytes: Uint8Array }>;
  threadId?: string;
  inReplyToHash?: string;
  messageId?: string;
  includeSenderKey?: boolean;
  keysFor?: Identity[];
}

async function seal(options: SealOptions): Promise<Record<string, unknown>> {
  const messageId = options.messageId ?? crypto.randomUUID();
  const subject = options.subject ?? 'Hello';
  const text = options.text ?? 'Body text';
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const metaAttachments = (options.attachments ?? []).map((attachment) => {
      const id = crypto.randomUUID();
      return { id, filename: attachment.name, content_type: attachment.type, size_bytes: attachment.bytes.byteLength };
    });
    const metaEnc = await encryptString(
      contentKey,
      JSON.stringify({
        subject,
        from_name: 'Sender',
        snippet: text.slice(0, 160),
        to: options.recipients.map((recipient) => recipient.address),
        cc: [],
        attachments: metaAttachments,
      }),
      metaInfo(messageId),
    );
    const subjectEnc = await encryptString(contentKey, subject, subjectInfo(messageId));
    const fromNameEnc = await encryptString(contentKey, 'Sender', fromNameInfo(messageId));
    const payload = await encryptPayload(contentKey, new TextEncoder().encode(JSON.stringify({ text })), messageId);

    const attachments = [];
    for (const [index, attachment] of (options.attachments ?? []).entries()) {
      const id = metaAttachments[index]?.id as string;
      const key = await deriveAttachmentKey(contentKey, id);
      const sealed = await encryptBytes(key, attachment.bytes, attachmentKeyInfo(id));
      key.fill(0);
      attachments.push({
        id,
        iv: sealed.iv,
        ciphertext: b64(sealed.ciphertext),
        filename_enc: await encryptString(contentKey, attachment.name, `flaxia.mail.attachment-name.v1:${id}`),
        content_type: attachment.type,
        size_bytes: attachment.bytes.byteLength,
      });
    }

    const keyOwners = options.keysFor ?? [options.sender, ...options.recipients];
    const keys = [];
    for (const owner of keyOwners) {
      const wrapped = await wrapContentKey(contentKey, owner.spki, messageId, owner.address);
      keys.push({
        address: owner.address,
        key_version: 1,
        ephemeral_public_key: wrapped.ephemeralPublicKey,
        iv: wrapped.iv,
        wrapped_content_key: wrapped.wrappedContentKey,
      });
    }

    return {
      message_id: messageId,
      ...(options.threadId ? { thread_id: options.threadId } : {}),
      ...(options.inReplyToHash ? { in_reply_to_hash: options.inReplyToHash } : {}),
      from: options.from.address,
      to: options.recipients.map((recipient) => recipient.address),
      cc: [],
      bcc: [],
      subject_enc: subjectEnc,
      from_name_enc: fromNameEnc,
      meta_enc: metaEnc,
      payload: { iv: payload.iv, ciphertext: b64(payload.ciphertext) },
      attachments,
      keys,
    };
  } finally {
    contentKey.fill(0);
  }
}

async function postSend(
  envValue: MailEnv,
  sender: Identity,
  envelope: Record<string, unknown>,
  key?: string,
): Promise<Response> {
  return worker.fetch(
    await signed(envValue, sender.id, 'POST', '/internal/send', JSON.stringify(envelope), key),
    envValue,
  );
}

describe('internal E2EE send', () => {
  it('fans out to the recipient inbox and the sender Sent folder', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const bob = await makeIdentity('user-bob', 'bob');
    const sqlite = database(alice, bob);
    const { env: envValue, bucket } = env(sqlite);

    const envelope = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'Hi Bob', text: 'secret' });
    const response = await postSend(envValue, alice, envelope);
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as { ok: boolean; message_id: string; delivered: number };
    assert.equal(result.delivered, 2);

    const bobMessage = sqlite
      .prepare("SELECT * FROM mail_messages WHERE user_id = ? AND folder = 'inbox'")
      .get(bob.id) as Record<string, unknown>;
    assert.equal(bobMessage.from_addr, alice.address);
    assert.equal(bobMessage.direction, 'internal');
    assert.equal(bobMessage.security, 'e2ee');
    assert.equal(bobMessage.aad_id, envelope.message_id);
    assert.equal(bobMessage.message_id_hash, envelope.message_id);
    assert.equal(bobMessage.read_at, null);

    const aliceMessage = sqlite
      .prepare("SELECT * FROM mail_messages WHERE user_id = ? AND folder = 'sent'")
      .get(alice.id) as Record<string, unknown>;
    assert.equal(aliceMessage.aad_id, envelope.message_id);
    assert.ok(aliceMessage.read_at, 'sent copies are already read');

    const bobKey = sqlite
      .prepare('SELECT * FROM mail_message_keys WHERE message_id = ? AND recipient_address = ?')
      .get(bobMessage.id, bob.address) as Record<string, unknown>;
    const aliceKey = sqlite
      .prepare('SELECT * FROM mail_message_keys WHERE message_id = ? AND recipient_address = ?')
      .get(aliceMessage.id, alice.address) as Record<string, unknown>;
    assert.ok(bobKey?.wrapped_content_key);
    assert.ok(aliceKey?.wrapped_content_key);

    const events = sqlite.prepare('SELECT COUNT(*) AS count FROM mail_events WHERE user_id = ?').get(bob.id) as {
      count: number;
    };
    assert.equal(Number(events.count), 1);
    const aliceEvents = sqlite.prepare('SELECT COUNT(*) AS count FROM mail_events WHERE user_id = ?').get(alice.id) as {
      count: number;
    };
    assert.equal(Number(aliceEvents.count), 0);

    // The recipient copy must decrypt with the recipient's vault key only.
    const contentKey = await unwrapContentKey(
      {
        ephemeralPublicKey: String(bobKey.ephemeral_public_key),
        iv: String(bobKey.iv),
        wrappedContentKey: String(bobKey.wrapped_content_key),
      },
      bob.pkcs8,
      String(bobMessage.aad_id),
      bob.address,
    );
    const payloadBytes = bucket.objects.get(String(bobMessage.blob_id));
    assert.ok(payloadBytes);
    const plaintext = await decryptPayload(
      contentKey,
      String(bobMessage.payload_iv),
      payloadBytes,
      String(bobMessage.aad_id),
    );
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), { text: 'secret' });
    const meta = JSON.parse(
      await decryptString(contentKey, String(bobMessage.meta_enc), metaInfo(String(bobMessage.aad_id))),
    ) as { subject: string; to: string[] };
    assert.equal(meta.subject, 'Hi Bob');
    assert.deepEqual(meta.to, [bob.address]);
    contentKey.fill(0);

    const usage = sqlite.prepare('SELECT user_id, storage_bytes FROM mail_usage ORDER BY user_id').all() as Array<{
      user_id: string;
      storage_bytes: number;
    }>;
    assert.equal(usage.length, 2);
    assert.ok(usage.every((row) => Number(row.storage_bytes) > 0));

    const threads = sqlite
      .prepare('SELECT user_id, folder, message_count FROM mail_threads ORDER BY user_id')
      .all() as Array<{ user_id: string; folder: string; message_count: number }>;
    assert.deepEqual(
      threads.map((thread) => [thread.user_id, thread.folder, Number(thread.message_count)]),
      [
        [alice.id, 'sent', 1],
        [bob.id, 'inbox', 1],
      ],
    );
    sqlite.close();
  });

  it('threads replies for both mailboxes and keeps attachment IVs', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const bob = await makeIdentity('user-bob', 'bob');
    const sqlite = database(alice, bob);
    const { env: envValue } = env(sqlite);

    const first = await seal({
      from: alice,
      sender: alice,
      recipients: [bob],
      subject: 'Project',
      text: 'first',
      attachments: [{ name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('notes') }],
    });
    assert.equal((await postSend(envValue, alice, first)).status, 200);

    const bobThread = sqlite.prepare('SELECT id FROM mail_threads WHERE user_id = ?').get(bob.id) as { id: string };
    const bobMessage = sqlite
      .prepare('SELECT id, aad_id, message_id_hash FROM mail_messages WHERE user_id = ?')
      .get(bob.id) as { id: string; aad_id: string; message_id_hash: string };
    const attachment = sqlite
      .prepare('SELECT * FROM mail_attachments WHERE message_id = ?')
      .get(bobMessage.id) as Record<string, unknown>;
    assert.equal(attachment.aad_id, (first.attachments as Array<{ id: string }>)[0]?.id);
    assert.ok(String(attachment.iv).length > 0);

    const reply = await seal({
      from: bob,
      sender: bob,
      recipients: [alice],
      subject: 'Re: Project',
      text: 'reply',
      threadId: bobThread.id,
      inReplyToHash: bobMessage.message_id_hash,
    });
    const response = await postSend(envValue, bob, reply, 'send-test-key-reply');
    assert.equal(response.status, 200, await response.clone().text());

    const bobThreadAfter = sqlite
      .prepare('SELECT folder, message_count FROM mail_threads WHERE id = ?')
      .get(bobThread.id) as {
      folder: string;
      message_count: number;
    };
    assert.equal(bobThreadAfter.folder, 'inbox');
    assert.equal(Number(bobThreadAfter.message_count), 2);

    const aliceThread = sqlite
      .prepare('SELECT id, folder, message_count FROM mail_threads WHERE user_id = ?')
      .get(alice.id) as { id: string; folder: string; message_count: number };
    assert.equal(aliceThread.folder, 'inbox');
    assert.equal(Number(aliceThread.message_count), 2);
    const aliceReply = sqlite
      .prepare('SELECT in_reply_to_hash FROM mail_messages WHERE user_id = ? AND folder = ?')
      .get(alice.id, 'inbox') as { in_reply_to_hash: string };
    assert.equal(aliceReply.in_reply_to_hash, bobMessage.message_id_hash);
    sqlite.close();
  });

  it('rejects external recipients, spoofed From, stale keys and replays', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const bob = await makeIdentity('user-bob', 'bob');
    const sqlite = database(alice, bob);
    const { env: envValue } = env(sqlite);

    const external = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'x' });
    external.to = ['friend@example.com'];
    const externalResponse = await postSend(envValue, alice, external, 'send-test-external');
    assert.equal(externalResponse.status, 422);
    assert.equal(((await externalResponse.json()) as { error: string }).error, 'mail_external_unavailable');

    const spoof = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'x' });
    spoof.from = bob.address;
    const spoofResponse = await postSend(envValue, alice, spoof, 'send-test-spoof');
    assert.equal(spoofResponse.status, 403);
    assert.equal(((await spoofResponse.json()) as { error: string }).error, 'mail_from_not_owned');

    const stale = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'x' });
    for (const key of stale.keys as Array<{ key_version: number }>) key.key_version = 2;
    const staleResponse = await postSend(envValue, alice, stale, 'send-test-stale');
    assert.equal(staleResponse.status, 409);
    assert.equal(((await staleResponse.json()) as { error: string }).error, 'mail_key_rotated');

    const missingKey = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'x', keysFor: [alice] });
    const missingResponse = await postSend(envValue, alice, missingKey, 'send-test-missing-key');
    assert.equal(missingResponse.status, 400);
    assert.equal(((await missingResponse.json()) as { error: string }).error, 'mail_invalid_keys');

    const replay = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'once' });
    assert.equal((await postSend(envValue, alice, replay, 'send-test-replay')).status, 200);
    const before = (sqlite.prepare('SELECT COUNT(*) AS count FROM mail_messages').get() as { count: number }).count;
    const duplicate = await postSend(envValue, alice, replay, 'send-test-replay');
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { duplicate?: boolean }).duplicate, true);
    const after = (sqlite.prepare('SELECT COUNT(*) AS count FROM mail_messages').get() as { count: number }).count;
    assert.equal(Number(after), Number(before));

    sqlite.prepare('UPDATE mail_usage SET storage_bytes = ? WHERE user_id = ?').run(512 * 1024 * 1024, bob.id);
    const quota = await seal({ from: alice, sender: alice, recipients: [bob], subject: 'full' });
    const quotaResponse = await postSend(envValue, alice, quota, 'send-test-quota');
    assert.equal(quotaResponse.status, 507);
    assert.equal(((await quotaResponse.json()) as { error: string }).error, 'mail_quota_exceeded');
    sqlite.close();
  });
});

describe('encrypted drafts', () => {
  it('creates, lists, updates and deletes a draft', async () => {
    const alice = await makeIdentity('user-alice', 'alice');
    const bob = await makeIdentity('user-bob', 'bob');
    const sqlite = database(alice, bob);
    const { env: envValue, bucket } = env(sqlite);

    const draft = await seal({
      from: alice,
      sender: alice,
      recipients: [bob],
      subject: 'WIP',
      text: 'draft body',
      keysFor: [alice],
    });
    const created = await worker.fetch(
      await signed(envValue, alice.id, 'POST', '/internal/drafts', JSON.stringify(draft), 'draft-create-0001'),
      envValue,
    );
    assert.equal(created.status, 200, await created.clone().text());
    const draftId = ((await created.json()) as { draft_id: string }).draft_id;
    assert.equal(draftId, draft.message_id);

    const row = sqlite.prepare('SELECT * FROM mail_messages WHERE id = ?').get(draftId) as Record<string, unknown>;
    assert.equal(row.direction, 'draft');
    assert.equal(row.folder, 'drafts');
    assert.equal(row.aad_id, draftId);
    const thread = sqlite.prepare('SELECT folder FROM mail_threads WHERE id = ?').get(String(row.thread_id)) as {
      folder: string;
    };
    assert.equal(thread.folder, 'drafts');

    const listed = await worker.fetch(await signed(envValue, alice.id, 'GET', '/internal/drafts'), envValue);
    assert.equal(listed.status, 200);
    const drafts = ((await listed.json()) as { drafts: Array<{ id: string; key: unknown }> }).drafts;
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.id, draftId);
    assert.ok(drafts[0]?.key);

    const detailResponse = await worker.fetch(
      await signed(envValue, alice.id, 'GET', `/internal/drafts/${draftId}`),
      envValue,
    );
    assert.equal(detailResponse.status, 200);
    const payloadResponse = await worker.fetch(
      await signed(envValue, alice.id, 'GET', `/internal/drafts/${draftId}/payload`),
      envValue,
    );
    assert.equal(payloadResponse.status, 200);
    const payloadBytes = new Uint8Array(await payloadResponse.arrayBuffer());
    assert.ok(payloadBytes.byteLength > 0);

    const updated = await seal({
      from: alice,
      sender: alice,
      recipients: [bob],
      subject: 'WIP v2',
      text: 'updated body',
      keysFor: [alice],
      messageId: draftId,
    });
    const patch = await worker.fetch(
      await signed(
        envValue,
        alice.id,
        'PATCH',
        `/internal/drafts/${draftId}`,
        JSON.stringify(updated),
        'draft-patch-001',
      ),
      envValue,
    );
    assert.equal(patch.status, 200, await patch.clone().text());
    const patched = sqlite.prepare('SELECT payload_iv, aad_id FROM mail_messages WHERE id = ?').get(draftId) as {
      payload_iv: string;
      aad_id: string;
    };
    assert.equal(patched.aad_id, draftId);
    assert.notEqual(patched.payload_iv, String(row.payload_iv));

    const removed = await worker.fetch(
      await signed(envValue, alice.id, 'DELETE', `/internal/drafts/${draftId}`),
      envValue,
    );
    assert.equal(removed.status, 200);
    assert.equal(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM mail_messages WHERE id = ?').get(draftId) as { count: number })
        .count,
      0,
    );
    assert.equal(
      (
        sqlite.prepare('SELECT COUNT(*) AS count FROM mail_threads WHERE user_id = ?').get(alice.id) as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        sqlite.prepare('SELECT storage_bytes FROM mail_usage WHERE user_id = ?').get(alice.id) as {
          storage_bytes: number;
        }
      ).storage_bytes,
      0,
    );
    assert.equal(
      [...bucket.objects.keys()].filter((key) => key.includes(draftId)).length,
      0,
      'draft ciphertext is removed from R2',
    );
    sqlite.close();
  });
});
