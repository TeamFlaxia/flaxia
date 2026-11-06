/// <reference types="@cloudflare/workers-types" />
// Inbound pipeline (docs/mail.md §9.1). P1 skeleton — full MIME parse/threading
// lands in P2. Security invariants already enforced here:
//   - 10 MiB cap, unknown/disabled recipients rejected (550), no fallback forward
//   - the payload is encrypted with the per-message content key before it is
//     written to R2; only ciphertext is persisted (docs/mail.md §6.1, §7)
import { encryptPayload, wrapContentKey } from './crypto.ts';

export const MAX_INBOUND_BYTES = 10 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 512 * 1024 * 1024;

export interface MailEnv {
  MAIL_DB: D1Database;
  MAIL_BUCKET: R2Bucket;
  MAIL_QUEUE: Queue;
  MAIL_QUEUE_DLQ: Queue;
  MAIL_SEND?: { send(message: unknown): Promise<void> };
  MAIL_DOMAIN?: string;
  MAIL_THREAD_SECRET?: string;
  MAIL_INTERNAL_SECRET?: string;
}

export async function handleInboundEmail(env: MailEnv, raw: ArrayBuffer, toAddress: string): Promise<void> {
  const normalizedTo = toAddress.trim().toLowerCase();
  if (raw.byteLength > MAX_INBOUND_BYTES) throw new Error('mail_too_large');

  const address = await env.MAIL_DB.prepare('SELECT user_id, state FROM mail_addresses WHERE address = ?')
    .bind(normalizedTo)
    .first<{ user_id: string; state: string }>();
  // Apex cutover (D6): no human fallback forward. Unknown/disabled -> reject.
  if (!address || address.state !== 'active') throw Object.assign(new Error('mail_recipient_unknown'), { code: 550 });

  const identity = await env.MAIL_DB.prepare('SELECT public_key FROM mail_identities WHERE user_id = ?')
    .bind(address.user_id)
    .first<{ public_key: string }>();
  if (!identity) throw new Error('mail_identity_missing');

  const usage = await env.MAIL_DB.prepare('SELECT storage_bytes FROM mail_usage WHERE user_id = ?')
    .bind(address.user_id)
    .first<{ storage_bytes: number }>();
  if ((Number(usage?.storage_bytes) || 0) + raw.byteLength > MAX_STORAGE_BYTES) {
    throw Object.assign(new Error('mail_quota_exceeded'), { code: 552 });
  }

  const messageId = crypto.randomUUID();
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapContentKey(contentKey, identity.public_key, messageId, normalizedTo);

  // Encrypt the raw MIME with the per-message content key before it touches R2.
  // The content key itself is only stored wrapped for the recipient identity.
  const plaintext = new Uint8Array(raw);
  const encrypted = await encryptPayload(contentKey, plaintext, messageId).finally(() => {
    // Best-effort: drop the plaintext copy as soon as encryption finishes.
    plaintext.fill(0);
    contentKey.fill(0);
  });

  const r2Key = `mail/${address.user_id}/${messageId}/payload.enc`;
  await env.MAIL_BUCKET.put(r2Key, encrypted.ciphertext);

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `INSERT INTO mail_threads (id, user_id, subject_enc, last_message_at, message_count, unread_count, participants_enc)
       VALUES (?, ?, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, 1, '')`,
    ).bind(messageId, address.user_id),
    env.MAIL_DB.prepare(
      `INSERT INTO mail_messages (id, user_id, thread_id, direction, folder, from_addr, to_addr,
         security, size_bytes, blob_id, payload_iv, received_at)
       VALUES (?, ?, ?, 'inbound', 'inbox', '', ?, 'at_rest', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).bind(messageId, address.user_id, messageId, normalizedTo, raw.byteLength, r2Key, encrypted.iv),
    env.MAIL_DB.prepare(
      `INSERT INTO mail_message_keys (message_id, recipient_address, key_version, ephemeral_public_key, iv, wrapped_content_key)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).bind(messageId, normalizedTo, wrapped.ephemeralPublicKey, wrapped.iv, wrapped.wrappedContentKey),
    env.MAIL_DB.prepare(
      `INSERT INTO mail_usage (user_id, storage_bytes, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         storage_bytes = storage_bytes + excluded.storage_bytes,
         updated_at = excluded.updated_at`,
    ).bind(address.user_id, encrypted.ciphertext.byteLength),
  ]);
}
