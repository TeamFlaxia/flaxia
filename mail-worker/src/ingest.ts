/// <reference types="@cloudflare/workers-types" />
// Inbound pipeline (docs/mail.md §9.1). P2 parses MIME, resolves a thread,
// encrypts metadata/payload/attachments, and stores only ciphertext + routing
// metadata. External mail is plaintext during ingestion by design (D5).
// R2 writes happen only after the quota/recipient checks, and a failed D1
// batch discards the staged ciphertext (no undecryptable R2 orphans).
import {
  attachmentKeyInfo,
  attachmentNameInfo,
  deriveAttachmentKey,
  encryptBytes,
  encryptPayload,
  encryptString,
  fromNameInfo,
  metaInfo,
  subjectInfo,
  wrapContentKey,
} from './crypto.ts';
import { type ParsedInbound, parseInboundEmail } from './parse.ts';

export const MAX_INBOUND_BYTES = 10 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 512 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

export interface MailEnv {
  MAIL_DB: D1Database;
  MAIL_BUCKET: R2Bucket;
  MAIL_QUEUE: Queue;
  MAIL_QUEUE_DLQ: Queue;
  MAIL_SEND?: { send(message: unknown): Promise<void> };
  MAIL_DOMAIN?: string;
  MAIL_THREAD_SECRET?: string;
  MAIL_INTERNAL_SECRET?: string;
  MAIL_INBOUND_ENABLED?: string;
}

interface ThreadRow {
  id: string;
}

export async function handleInboundEmail(
  env: MailEnv,
  raw: ArrayBuffer,
  toAddress: string,
  envelopeFrom = '',
  headers?: Headers,
): Promise<void> {
  const normalizedTo = toAddress.trim().toLowerCase();
  if (raw.byteLength > MAX_INBOUND_BYTES) throw new Error('mail_too_large');

  const address = await env.MAIL_DB.prepare('SELECT user_id, state FROM mail_addresses WHERE address = ?')
    .bind(normalizedTo)
    .first<{ user_id: string; state: string }>();
  // Apex cutover (D6): no human fallback forward. Unknown/disabled -> reject.
  if (!address || address.state !== 'active') throw Object.assign(new Error('mail_recipient_unknown'), { code: 550 });
  // User ids are database identifiers; this one is interpolated into an R2 key.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(address.user_id)) throw new Error('mail_invalid_user');

  const identity = await env.MAIL_DB.prepare('SELECT public_key, key_version FROM mail_identities WHERE user_id = ?')
    .bind(address.user_id)
    .first<{ public_key: string; key_version: number }>();
  if (!identity) throw new Error('mail_identity_missing');

  let parsed: ParsedInbound;
  try {
    parsed = await parseInboundEmail({
      raw,
      envelopeFrom,
      envelopeTo: normalizedTo,
      headers,
      threadSecret: env.MAIL_THREAD_SECRET,
    });
  } catch (err) {
    // Corrupt/depth-limited MIME is a permanent failure; the coded error makes
    // the email() handler setReject instead of retrying an unparseable message.
    throw Object.assign(new Error('mail_parse_failed'), { code: 554, cause: err });
  }
  new Uint8Array(raw).fill(0);

  if (parsed.attachments.length > MAX_ATTACHMENTS) {
    throw Object.assign(new Error('mail_too_many_attachments'), { code: 554 });
  }

  const usage = await env.MAIL_DB.prepare('SELECT storage_bytes FROM mail_usage WHERE user_id = ?')
    .bind(address.user_id)
    .first<{ storage_bytes: number }>();
  // Attachments are already part of the raw message, so the early gate tallies
  // raw size only; the exact ciphertext total is re-checked before any R2 write.
  if ((Number(usage?.storage_bytes) || 0) + raw.byteLength > MAX_STORAGE_BYTES) {
    throw Object.assign(new Error('mail_quota_exceeded'), { code: 552 });
  }

  const messageId = crypto.randomUUID();
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrapped = await wrapContentKey(contentKey, identity.public_key, messageId, normalizedTo);

    const attachmentMeta = parsed.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      content_type: attachment.contentType,
      size_bytes: attachment.sizeBytes,
      inline: attachment.inline,
      blocked: attachment.blocked,
    }));
    const metadata = {
      subject: parsed.subject,
      from_name: parsed.fromName,
      snippet: parsed.snippet,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      reply_to: parsed.replyTo,
      attachments: attachmentMeta,
      auth: parsed.auth,
      spam_reason: parsed.spamReason,
    };
    const metaEnc = await encryptString(contentKey, JSON.stringify(metadata), metaInfo(messageId));
    const subjectEnc = await encryptString(contentKey, parsed.subject, subjectInfo(messageId));
    const fromNameEnc = await encryptString(contentKey, parsed.fromName, fromNameInfo(messageId));

    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({ text: parsed.text, html: parsed.html, attachments: attachmentMeta }),
    );
    let encryptedPayload: { iv: string; ciphertext: Uint8Array };
    try {
      encryptedPayload = await encryptPayload(contentKey, payloadBytes, messageId);
    } finally {
      payloadBytes.fill(0);
    }

    const r2Key = `mail/${address.user_id}/${messageId}/payload.enc`;
    const staged: Array<{ key: string; bytes: Uint8Array }> = [{ key: r2Key, bytes: encryptedPayload.ciphertext }];
    let storedBytes = encryptedPayload.ciphertext.byteLength;

    const attachments: Array<{
      id: string;
      filenameEnc: string;
      contentType: string;
      sizeBytes: number;
      r2Key: string;
      scanStatus: string;
    }> = [];
    // Seal every attachment in memory; the R2 writes happen after the quota and
    // recipient re-checks below so a rejected message never leaves objects behind.
    for (const attachment of parsed.attachments) {
      const filenameEnc = await encryptString(contentKey, attachment.filename, attachmentNameInfo(attachment.id));
      let attachmentR2Key = '';
      let scanStatus = 'blocked';
      if (!attachment.blocked) {
        const attachmentKey = await deriveAttachmentKey(contentKey, attachment.id);
        try {
          const sealed = await encryptBytes(attachmentKey, attachment.content, attachmentKeyInfo(attachment.id));
          attachmentR2Key = `mail/${address.user_id}/${messageId}/attachments/${attachment.id}.enc`;
          staged.push({ key: attachmentR2Key, bytes: sealed.ciphertext });
          storedBytes += sealed.ciphertext.byteLength;
          scanStatus = 'pending';
        } finally {
          attachmentKey.fill(0);
          attachment.content.fill(0);
        }
      } else {
        attachment.content.fill(0);
      }
      attachments.push({
        id: attachment.id,
        filenameEnc,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        r2Key: attachmentR2Key,
        scanStatus,
      });
    }

    if ((Number(usage?.storage_bytes) || 0) + storedBytes > MAX_STORAGE_BYTES) {
      throw Object.assign(new Error('mail_quota_exceeded'), { code: 552 });
    }

    // If the address disappeared during processing, do not write R2 or commit
    // mailbox data for a dead mailbox.
    const stillActive = await env.MAIL_DB.prepare('SELECT user_id, state FROM mail_addresses WHERE address = ?')
      .bind(normalizedTo)
      .first<{ user_id: string; state: string }>();
    if (!stillActive || stillActive.state !== 'active' || stillActive.user_id !== address.user_id) {
      throw Object.assign(new Error('mail_recipient_unknown'), { code: 550 });
    }

    const discardStaged = (count: number): Promise<unknown> =>
      Promise.all(staged.slice(0, count).map((object) => env.MAIL_BUCKET.delete(object.key).catch(() => undefined)));

    let written = 0;
    try {
      for (const object of staged) {
        await env.MAIL_BUCKET.put(object.key, object.bytes);
        written += 1;
      }
    } catch (err) {
      await discardStaged(written);
      throw err;
    }

    // Thread resolution: direct parent first, then a recent subject fallback.
    let threadId = '';
    const parentHashes = [parsed.inReplyToHash, ...parsed.referenceHashes.slice().reverse()].filter(Boolean);
    for (const hash of parentHashes) {
      const parent = await env.MAIL_DB.prepare(
        'SELECT thread_id FROM mail_messages WHERE user_id = ? AND message_id_hash = ? LIMIT 1',
      )
        .bind(address.user_id, hash)
        .first<{ thread_id: string }>();
      if (parent) {
        threadId = parent.thread_id;
        break;
      }
    }
    if (!threadId && parsed.subjectKey) {
      const subjectThread = await env.MAIL_DB.prepare(
        `SELECT id FROM mail_threads
         WHERE user_id = ? AND thread_key = ?
           AND last_message_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
         ORDER BY last_message_at DESC LIMIT 1`,
      )
        .bind(address.user_id, parsed.subjectKey)
        .first<ThreadRow>();
      if (subjectThread) threadId = subjectThread.id;
    }
    const isNewThread = !threadId;
    if (!threadId) threadId = crypto.randomUUID();

    const folder = parsed.spam ? 'spam' : 'inbox';
    const receivedAt = new Date().toISOString();
    const sentDate = parsed.date ? new Date(parsed.date) : null;
    const sentAt = sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate.toISOString() : null;

    const statements: D1PreparedStatement[] = [];
    if (isNewThread) {
      statements.push(
        env.MAIL_DB.prepare(
          `INSERT INTO mail_threads
             (id, user_id, subject_enc, last_message_at, message_count, unread_count, participants_enc, thread_key, folder)
           VALUES (?, ?, ?, ?, 1, ?, '', ?, ?)`,
        ).bind(
          threadId,
          address.user_id,
          subjectEnc,
          receivedAt,
          folder === 'inbox' ? 1 : 0,
          parsed.subjectKey,
          folder,
        ),
      );
    } else {
      statements.push(
        env.MAIL_DB.prepare(
          `UPDATE mail_threads
           SET folder = ?, last_message_at = ?, message_count = message_count + 1,
               unread_count = unread_count + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ? AND user_id = ?`,
        ).bind(folder, receivedAt, folder === 'inbox' ? 1 : 0, threadId, address.user_id),
      );
    }

    statements.push(
      env.MAIL_DB.prepare(
        `INSERT INTO mail_messages
           (id, user_id, thread_id, direction, folder, from_addr, to_addr, from_name_enc,
            to_enc, cc_enc, bcc_enc, reply_to_enc, subject_enc, meta_enc,
            message_id_hash, in_reply_to_hash, references_hash, sent_at, received_at,
            size_bytes, has_attachments, read_at, starred_at, security, auth_results,
            spam_score, blob_id, payload_iv, raw_blob_key, deleted_at)
         VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, '', '', '', '', ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, NULL, NULL, 'at_rest', ?, ?, ?, ?, '', NULL)`,
      ).bind(
        messageId,
        address.user_id,
        threadId,
        folder,
        parsed.fromAddress,
        normalizedTo,
        fromNameEnc,
        subjectEnc,
        metaEnc,
        parsed.messageIdHash,
        parsed.inReplyToHash,
        parsed.referenceHashes.at(-1) ?? '',
        sentAt,
        receivedAt,
        storedBytes,
        parsed.attachments.length > 0 ? 1 : 0,
        JSON.stringify(parsed.auth),
        parsed.spam ? 1 : 0,
        r2Key,
        encryptedPayload.iv,
      ),
    );

    statements.push(
      env.MAIL_DB.prepare(
        `INSERT INTO mail_message_keys
           (message_id, recipient_address, key_version, ephemeral_public_key, iv, wrapped_content_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        messageId,
        normalizedTo,
        identity.key_version,
        wrapped.ephemeralPublicKey,
        wrapped.iv,
        wrapped.wrappedContentKey,
      ),
    );

    statements.push(
      env.MAIL_DB.prepare(
        `INSERT INTO mail_blobs (id, r2_key, size_bytes, content_hash, ref_count)
         VALUES (?, ?, ?, '', 1)`,
      ).bind(messageId, r2Key, encryptedPayload.ciphertext.byteLength),
    );

    for (const attachment of attachments) {
      statements.push(
        env.MAIL_DB.prepare(
          `INSERT INTO mail_attachments
             (id, message_id, user_id, filename_enc, content_type, size_bytes, r2_key, content_hash, scan_status, cid_enc)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '')`,
        ).bind(
          attachment.id,
          messageId,
          address.user_id,
          attachment.filenameEnc,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.r2Key,
          attachment.scanStatus,
        ),
      );
    }

    statements.push(
      env.MAIL_DB.prepare(
        `INSERT INTO mail_usage (user_id, storage_bytes, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(user_id) DO UPDATE SET
           storage_bytes = storage_bytes + excluded.storage_bytes,
           updated_at = excluded.updated_at`,
      ).bind(address.user_id, storedBytes),
    );

    if (folder === 'inbox') {
      statements.push(
        env.MAIL_DB.prepare(`INSERT INTO mail_events (id, user_id, kind, cursor) VALUES (?, ?, 'new_mail', ?)`).bind(
          crypto.randomUUID(),
          address.user_id,
          messageId,
        ),
      );
    }

    try {
      // The batch is atomic in D1, so an exception here means nothing was
      // committed: discard the staged ciphertext instead of leaving
      // undecryptable orphans in R2.
      await env.MAIL_DB.batch(statements);
    } catch (err) {
      await discardStaged(staged.length);
      throw err;
    }
  } finally {
    contentKey.fill(0);
  }
}
