/// <reference types="@cloudflare/workers-types" />
// Outbound pipeline (docs/mail.md §9.2) and encrypted drafts (§10).
//
// Internal E2EE delivery: the client seals metadata/subject/payload/attachments
// once with a per-message content key and wraps that key for every recipient
// plus the sender. The Worker never sees subject, body, or attachment names; it
// fans the ciphertext out to one message row per mailbox, resolves threads, and
// writes the Sent copy. Any external recipient is rejected until the SMTP path
// (M2) lands, so this module cannot silently downgrade E2EE.
//
// Drafts reuse the same envelope but wrap the content key for the sender only
// and store the row under direction='draft'/folder='drafts'.

import { claimIdempotency, error, idempotencyKey, type Json, json, readJsonBody } from './http.ts';
import { MAX_STORAGE_BYTES, type MailEnv } from './ingest.ts';

// Constants shared with the external-send path (M2) and the MIME guard tests.
export const MAX_OUTBOUND_BYTES = 10 * 1024 * 1024;
export const MAX_SEND_BODY = 16 * 1024 * 1024;
export const MAX_RECIPIENTS = 20;
export const MAX_ATTACHMENTS = 20;
export const DEFAULT_DAILY_EXTERNAL_SENDS = 20;
export const DEFAULT_STORAGE_QUOTA_BYTES = 512 * 1024 * 1024;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const ENVELOPE_PATTERN = /^[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/;
const MAX_SUBJECT_ENC = 8 * 1024;
const MAX_FROM_NAME_ENC = 2 * 1024;
const MAX_META_ENC = 64 * 1024;

/** Header injection guard for the external SMTP path (RFC 5322 / §9.2). */
export function assertNoHeaderInjection(value: string, field: string): void {
  if (value.includes('\r') || value.includes('\n')) throw new Error(`mail_header_injection:${field}`);
}

export function validateOutboundRecipients(recipients: string[]): string[] {
  if (recipients.length === 0) throw new Error('mail_no_recipients');
  if (recipients.length > MAX_RECIPIENTS) throw new Error('mail_too_many_recipients');
  for (const r of recipients) assertNoHeaderInjection(r, 'to');
  return recipients.map((r) => r.trim().toLowerCase());
}

export function validateOutboundSize(bytes: number): void {
  if (bytes > MAX_OUTBOUND_BYTES) throw new Error('mail_too_large');
}

interface AttachmentInput {
  id: string;
  iv: string;
  ciphertext: string;
  bytes: number;
  filenameEnc: string;
  contentType: string;
  sizeBytes: number;
}

interface KeyInput {
  address: string;
  keyVersion: number;
  ephemeralPublicKey: string;
  iv: string;
  wrappedContentKey: string;
}

interface Envelope {
  messageId: string;
  threadId: string;
  inReplyToHash: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subjectEnc: string;
  fromNameEnc: string;
  metaEnc: string;
  payload: { iv: string; ciphertext: string; bytes: number };
  attachments: AttachmentInput[];
  keys: KeyInput[];
}

type Invalid = { error: string; status: number };

function invalid(code: string, status = 400): Invalid {
  return { error: code, status };
}

function b64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254) return null;
  if (/\s/.test(normalized)) return null;
  const at = normalized.lastIndexOf('@');
  if (at < 1 || at === normalized.length - 1) return null;
  return normalized;
}

function normalizeList(value: unknown, max: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    const address = normalizeAddress(entry);
    if (!address) return null;
    out.push(address);
  }
  return out;
}

function parseEnvelope(raw: Json): Envelope | Invalid {
  const messageId = typeof raw.message_id === 'string' ? raw.message_id : '';
  if (!ID_PATTERN.test(messageId)) return invalid('mail_invalid_message');

  const from = normalizeAddress(raw.from);
  if (!from) return invalid('mail_invalid_from');

  const to = normalizeList(raw.to, MAX_RECIPIENTS);
  const cc = normalizeList(raw.cc, MAX_RECIPIENTS);
  const bcc = normalizeList(raw.bcc, MAX_RECIPIENTS);
  if (!to || !cc || !bcc) return invalid('mail_invalid_recipient');

  const threadId = typeof raw.thread_id === 'string' ? raw.thread_id : '';
  if (threadId && !ID_PATTERN.test(threadId)) return invalid('mail_invalid_thread');
  const inReplyToHash = typeof raw.in_reply_to_hash === 'string' ? raw.in_reply_to_hash : '';
  if (inReplyToHash && !HASH_PATTERN.test(inReplyToHash)) return invalid('mail_invalid_thread');

  const subjectEnc = typeof raw.subject_enc === 'string' ? raw.subject_enc : '';
  if (subjectEnc.length > MAX_SUBJECT_ENC || !ENVELOPE_PATTERN.test(subjectEnc)) {
    return invalid('mail_invalid_body');
  }
  const fromNameEnc = typeof raw.from_name_enc === 'string' ? raw.from_name_enc : '';
  if (fromNameEnc.length > MAX_FROM_NAME_ENC || (fromNameEnc !== '' && !ENVELOPE_PATTERN.test(fromNameEnc))) {
    return invalid('mail_invalid_body');
  }
  const metaEnc = typeof raw.meta_enc === 'string' ? raw.meta_enc : '';
  if (metaEnc.length > MAX_META_ENC || !ENVELOPE_PATTERN.test(metaEnc)) {
    return invalid('mail_invalid_body');
  }

  const payloadRaw = raw.payload;
  if (typeof payloadRaw !== 'object' || payloadRaw === null || Array.isArray(payloadRaw)) {
    return invalid('mail_invalid_body');
  }
  const payload = payloadRaw as { iv?: unknown; ciphertext?: unknown };
  const payloadIv = typeof payload.iv === 'string' ? payload.iv : '';
  const payloadCiphertext = typeof payload.ciphertext === 'string' ? payload.ciphertext : '';
  if (!payloadIv || !payloadCiphertext || !CIPHERTEXT_PATTERN.test(payloadCiphertext)) {
    return invalid('mail_invalid_body');
  }
  const payloadBytes = b64Bytes(payloadCiphertext);
  if (payloadBytes > MAX_OUTBOUND_BYTES) return invalid('mail_too_large', 413);

  const attachments: AttachmentInput[] = [];
  const attachmentRaw = raw.attachments;
  if (attachmentRaw !== undefined) {
    if (!Array.isArray(attachmentRaw)) return invalid('mail_invalid_attachment');
    if (attachmentRaw.length > MAX_ATTACHMENTS) return invalid('mail_too_many_attachments', 413);
    const seen = new Set<string>();
    for (const entry of attachmentRaw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return invalid('mail_invalid_attachment');
      }
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : '';
      if (!ID_PATTERN.test(id) || seen.has(id)) return invalid('mail_invalid_attachment');
      seen.add(id);
      const iv = typeof item.iv === 'string' ? item.iv : '';
      const ciphertext = typeof item.ciphertext === 'string' ? item.ciphertext : '';
      if (!iv || !ciphertext || !CIPHERTEXT_PATTERN.test(ciphertext)) {
        return invalid('mail_invalid_attachment');
      }
      const filenameEnc = typeof item.filename_enc === 'string' ? item.filename_enc : '';
      if (filenameEnc.length > MAX_FROM_NAME_ENC || (filenameEnc !== '' && !ENVELOPE_PATTERN.test(filenameEnc))) {
        return invalid('mail_invalid_attachment');
      }
      const contentType = typeof item.content_type === 'string' ? item.content_type : 'application/octet-stream';
      if (contentType.length > 128 || /[\r\n]/.test(contentType)) return invalid('mail_invalid_attachment');
      const sizeBytes = Number(item.size_bytes ?? 0);
      if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_OUTBOUND_BYTES) {
        return invalid('mail_invalid_attachment');
      }
      attachments.push({
        id,
        iv,
        ciphertext,
        bytes: b64Bytes(ciphertext),
        filenameEnc,
        contentType,
        sizeBytes,
      });
    }
  }

  const totalBytes = payloadBytes + attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
  if (totalBytes > MAX_OUTBOUND_BYTES) return invalid('mail_too_large', 413);

  const keysRaw = raw.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0 || keysRaw.length > MAX_RECIPIENTS + 1) {
    return invalid('mail_invalid_keys');
  }
  const keys: KeyInput[] = [];
  const seenKeys = new Set<string>();
  for (const entry of keysRaw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return invalid('mail_invalid_keys');
    const item = entry as Record<string, unknown>;
    const address = normalizeAddress(item.address);
    const keyVersion = Number(item.key_version ?? 1);
    const ephemeralPublicKey = typeof item.ephemeral_public_key === 'string' ? item.ephemeral_public_key : '';
    const iv = typeof item.iv === 'string' ? item.iv : '';
    const wrappedContentKey = typeof item.wrapped_content_key === 'string' ? item.wrapped_content_key : '';
    if (!address || seenKeys.has(address)) return invalid('mail_invalid_keys');
    if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 1_000_000) return invalid('mail_invalid_keys');
    if (!ephemeralPublicKey || !iv || !wrappedContentKey) return invalid('mail_invalid_keys');
    if (ephemeralPublicKey.length > 512 || iv.length > 64 || wrappedContentKey.length > 256) {
      return invalid('mail_invalid_keys');
    }
    seenKeys.add(address);
    keys.push({ address, keyVersion, ephemeralPublicKey, iv, wrappedContentKey });
  }

  return {
    messageId,
    threadId,
    inReplyToHash,
    from,
    to,
    cc,
    bcc,
    subjectEnc,
    fromNameEnc,
    metaEnc,
    payload: { iv: payloadIv, ciphertext: payloadCiphertext, bytes: payloadBytes },
    attachments,
    keys,
  };
}

interface AddressRow {
  address: string;
  user_id: string;
  state: string;
}

interface IdentityRow {
  user_id: string;
  public_key: string;
  key_version: number;
}

async function loadAddressRows(env: MailEnv, addresses: string[]): Promise<Map<string, AddressRow>> {
  const rows = await env.MAIL_DB.prepare(
    `SELECT address, user_id, state FROM mail_addresses
     WHERE address IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(addresses))
    .all<AddressRow>();
  return new Map((rows.results ?? []).map((row) => [row.address, row]));
}

async function loadIdentities(env: MailEnv, userIds: string[]): Promise<Map<string, IdentityRow>> {
  const rows = await env.MAIL_DB.prepare(
    `SELECT user_id, public_key, key_version FROM mail_identities
     WHERE user_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(userIds))
    .all<IdentityRow>();
  return new Map((rows.results ?? []).map((row) => [row.user_id, row]));
}

async function loadUsage(env: MailEnv, userIds: string[]): Promise<Map<string, number>> {
  const rows = await env.MAIL_DB.prepare(
    `SELECT user_id, storage_bytes FROM mail_usage
     WHERE user_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(userIds))
    .all<{ user_id: string; storage_bytes: number }>();
  return new Map((rows.results ?? []).map((row) => [row.user_id, Number(row.storage_bytes) || 0]));
}

async function findThreadByHash(env: MailEnv, userId: string, hash: string): Promise<string> {
  const row = await env.MAIL_DB.prepare(
    'SELECT thread_id FROM mail_messages WHERE user_id = ? AND message_id_hash = ? AND deleted_at IS NULL LIMIT 1',
  )
    .bind(userId, hash)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? '';
}

function usageUpsert(env: MailEnv, userId: string, delta: number): D1PreparedStatement {
  return env.MAIL_DB.prepare(
    `INSERT INTO mail_usage (user_id, storage_bytes, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id) DO UPDATE SET
       storage_bytes = MAX(0, storage_bytes + excluded.storage_bytes),
       updated_at = excluded.updated_at`,
  ).bind(userId, delta);
}

function insertAttachment(
  env: MailEnv,
  row: {
    id: string;
    messageId: string;
    userId: string;
    filenameEnc: string;
    contentType: string;
    sizeBytes: number;
    r2Key: string;
    aadId: string;
    iv: string;
  },
): D1PreparedStatement {
  return env.MAIL_DB.prepare(
    `INSERT INTO mail_attachments
       (id, message_id, user_id, filename_enc, content_type, size_bytes, r2_key, content_hash, scan_status, cid_enc, aad_id, iv)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', 'pending', '', ?, ?)`,
  ).bind(
    row.id,
    row.messageId,
    row.userId,
    row.filenameEnc,
    row.contentType,
    row.sizeBytes,
    row.r2Key,
    row.aadId,
    row.iv,
  );
}

function insertKey(env: MailEnv, messageId: string, address: string, key: KeyInput): D1PreparedStatement {
  return env.MAIL_DB.prepare(
    `INSERT INTO mail_message_keys
       (message_id, recipient_address, key_version, ephemeral_public_key, iv, wrapped_content_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(messageId, address, key.keyVersion, key.ephemeralPublicKey, key.iv, key.wrappedContentKey);
}

function insertBlob(env: MailEnv, id: string, r2Key: string, sizeBytes: number): D1PreparedStatement {
  return env.MAIL_DB.prepare(
    `INSERT INTO mail_blobs (id, r2_key, size_bytes, content_hash, ref_count)
     VALUES (?, ?, ?, '', 1)`,
  ).bind(id, r2Key, sizeBytes);
}

function storedBytes(envelope: Envelope): number {
  return envelope.payload.bytes + envelope.attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
}

async function writeStaged(
  env: MailEnv,
  staged: Array<{ key: string; bytes: Uint8Array }>,
  statements: D1PreparedStatement[],
): Promise<boolean> {
  const discard = (count: number): Promise<unknown> =>
    Promise.all(staged.slice(0, count).map((object) => env.MAIL_BUCKET.delete(object.key).catch(() => undefined)));

  const written: string[] = [];
  const CONCURRENCY = 8;
  try {
    for (let index = 0; index < staged.length; index += CONCURRENCY) {
      await Promise.all(
        staged.slice(index, index + CONCURRENCY).map(async (object) => {
          await env.MAIL_BUCKET.put(object.key, object.bytes);
          written.push(object.key);
        }),
      );
    }
  } catch {
    // A chunk can fail after some of its members were written; keep the ones we
    // know about and delete the rest so no orphans survive.
    const committed = new Set(written);
    await Promise.all(
      staged
        .filter((object) => !committed.has(object.key))
        .map((object) => env.MAIL_BUCKET.delete(object.key).catch(() => undefined)),
    );
    return false;
  }

  try {
    // The batch is atomic in D1: a failure means nothing was committed, so the
    // staged ciphertext is discarded instead of leaving orphans in R2.
    await env.MAIL_DB.batch(statements);
    return true;
  } catch {
    await discard(staged.length);
    return false;
  }
}

async function deliver(env: MailEnv, userId: string, envelope: Envelope): Promise<Response> {
  const addresses = await loadAddressRows(env, [envelope.from]);
  const sender = addresses.get(envelope.from);
  if (!sender || sender.user_id !== userId || sender.state !== 'active') {
    return error('mail_from_not_owned', 403);
  }

  if (envelope.to.length === 0) return error('mail_no_recipients');
  const recipients = [...new Set([...envelope.to, ...envelope.cc, ...envelope.bcc])];
  if (recipients.length > MAX_RECIPIENTS) return error('mail_too_many_recipients');

  const domain = (env.MAIL_DOMAIN ?? 'flaxia.app').toLowerCase();
  if (recipients.some((address) => !address.endsWith(`@${domain}`))) {
    // M2 adds the external/TLS path; until then the client must not promise it.
    return error('mail_external_unavailable', 422);
  }

  const addressRows = await loadAddressRows(env, [...recipients, envelope.from]);
  for (const address of recipients) {
    const row = addressRows.get(address);
    if (!row || row.state !== 'active') return error('mail_recipient_unknown', 422);
  }

  const identityUserIds = [
    ...new Set([...recipients, envelope.from].map((address) => addressRows.get(address)?.user_id ?? '')),
  ];
  if (identityUserIds.some((id) => id === '')) return error('mail_recipient_unknown', 422);
  const identities = await loadIdentities(env, identityUserIds);
  for (const id of identityUserIds) {
    if (!identities.has(id)) return error('mail_recipient_unknown', 422);
  }

  const keyByAddress = new Map(envelope.keys.map((key) => [key.address, key]));
  const wanted = new Set([...recipients, envelope.from]);
  if (keyByAddress.size !== wanted.size) return error('mail_invalid_keys');
  for (const address of wanted) {
    const key = keyByAddress.get(address);
    const target = addressRows.get(address);
    const identity = target ? identities.get(target.user_id) : undefined;
    if (!key || !identity) return error('mail_invalid_keys');
    // A key rotation between the client's lookup and this request would produce
    // an undecryptable copy; ask the client to refetch instead of storing it.
    if (Number(identity.key_version) !== key.keyVersion) return error('mail_key_rotated', 409);
  }

  let senderThreadId = '';
  if (envelope.threadId || envelope.inReplyToHash) {
    if (envelope.threadId) {
      const thread = await env.MAIL_DB.prepare('SELECT id FROM mail_threads WHERE id = ? AND user_id = ?')
        .bind(envelope.threadId, userId)
        .first<{ id: string }>();
      if (!thread) return error('mail_thread_not_found', 404);
      senderThreadId = envelope.threadId;
    }
    if (envelope.inReplyToHash) {
      // §9.3: the Worker validates that the sender participates in the thread.
      const parentThread = await findThreadByHash(env, userId, envelope.inReplyToHash);
      if (!parentThread) return error('mail_thread_not_found', 404);
      if (senderThreadId && parentThread !== senderThreadId) return error('mail_thread_not_found', 404);
      senderThreadId = senderThreadId || parentThread;
    }
  }

  const bytes = storedBytes(envelope);
  const targetUserIds = identityUserIds;
  const usage = await loadUsage(env, targetUserIds);
  for (const id of targetUserIds) {
    if ((usage.get(id) ?? 0) + bytes > MAX_STORAGE_BYTES) return error('mail_quota_exceeded', 507);
  }

  interface CopyPlan {
    address: string;
    userId: string;
    folder: 'inbox' | 'sent';
    threadId: string;
    isNewThread: boolean;
    key: KeyInput;
    isSender: boolean;
  }

  const copies: CopyPlan[] = [];
  for (const address of recipients) {
    if (address === envelope.from) continue;
    const target = addressRows.get(address);
    if (!target) return error('mail_recipient_unknown', 422);
    const threadId = envelope.inReplyToHash ? await findThreadByHash(env, target.user_id, envelope.inReplyToHash) : '';
    copies.push({
      address,
      userId: target.user_id,
      folder: 'inbox',
      threadId,
      isNewThread: threadId === '',
      key: keyByAddress.get(address) as KeyInput,
      isSender: false,
    });
  }

  const senderResolved =
    senderThreadId || (envelope.inReplyToHash ? await findThreadByHash(env, userId, envelope.inReplyToHash) : '');
  copies.push({
    address: envelope.from,
    userId,
    folder: 'sent',
    threadId: senderResolved,
    isNewThread: senderResolved === '',
    key: keyByAddress.get(envelope.from) as KeyInput,
    isSender: true,
  });

  const receivedAt = new Date().toISOString();
  const payloadCiphertext = b64ToBytes(envelope.payload.ciphertext);
  const attachmentCiphertexts = envelope.attachments.map((attachment) => b64ToBytes(attachment.ciphertext));

  const staged: Array<{ key: string; bytes: Uint8Array }> = [];
  const statements: D1PreparedStatement[] = [];

  for (const copy of copies) {
    const copyId = crypto.randomUUID();
    const base = `mail/${copy.userId}/${copyId}`;
    const payloadKey = `${base}/payload.enc`;
    const threadId = copy.threadId || crypto.randomUUID();

    staged.push({ key: payloadKey, bytes: payloadCiphertext });

    if (copy.isNewThread) {
      statements.push(
        env.MAIL_DB.prepare(
          `INSERT INTO mail_threads
             (id, user_id, subject_enc, last_message_at, message_count, unread_count, participants_enc, thread_key, folder)
           VALUES (?, ?, ?, ?, 1, ?, '', '', ?)`,
        ).bind(threadId, copy.userId, envelope.subjectEnc, receivedAt, copy.folder === 'inbox' ? 1 : 0, copy.folder),
      );
    } else {
      // Inbox copies force the thread back into the inbox (a reply arrives
      // there); Sent copies never pull an existing conversation out of Inbox.
      statements.push(
        env.MAIL_DB.prepare(
          `UPDATE mail_threads
           SET folder = CASE WHEN ? = 'inbox' THEN 'inbox' ELSE folder END,
               last_message_at = ?,
               message_count = message_count + 1,
               unread_count = unread_count + ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ? AND user_id = ?`,
        ).bind(copy.folder, receivedAt, copy.folder === 'inbox' ? 1 : 0, threadId, copy.userId),
      );
    }

    statements.push(
      env.MAIL_DB.prepare(
        `INSERT INTO mail_messages
           (id, user_id, thread_id, direction, folder, from_addr, to_addr, from_name_enc,
            to_enc, cc_enc, bcc_enc, reply_to_enc, subject_enc, meta_enc,
            message_id_hash, in_reply_to_hash, references_hash, sent_at, received_at,
            size_bytes, has_attachments, read_at, starred_at, security, auth_results,
            spam_score, blob_id, payload_iv, raw_blob_key, deleted_at, aad_id)
         VALUES (?, ?, ?, 'internal', ?, ?, ?, ?, '', '', '', '', ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, NULL, 'e2ee', '{}', 0, ?, ?, '', NULL, ?)`,
      ).bind(
        copyId,
        copy.userId,
        threadId,
        copy.folder,
        envelope.from,
        envelope.to[0] ?? '',
        envelope.fromNameEnc,
        envelope.subjectEnc,
        envelope.metaEnc,
        envelope.messageId,
        envelope.inReplyToHash,
        envelope.inReplyToHash,
        receivedAt,
        receivedAt,
        bytes,
        envelope.attachments.length > 0 ? 1 : 0,
        copy.isSender ? receivedAt : null,
        payloadKey,
        envelope.payload.iv,
        envelope.messageId,
      ),
    );

    statements.push(insertKey(env, copyId, copy.address, copy.key));
    statements.push(insertBlob(env, copyId, payloadKey, envelope.payload.bytes));

    for (const [index, attachment] of envelope.attachments.entries()) {
      const rowId = crypto.randomUUID();
      const r2Key = `${base}/attachments/${rowId}.enc`;
      staged.push({ key: r2Key, bytes: attachmentCiphertexts[index] as Uint8Array });
      statements.push(
        insertAttachment(env, {
          id: rowId,
          messageId: copyId,
          userId: copy.userId,
          filenameEnc: attachment.filenameEnc,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          r2Key,
          aadId: attachment.id,
          iv: attachment.iv,
        }),
      );
    }

    statements.push(usageUpsert(env, copy.userId, bytes));

    if (copy.folder === 'inbox') {
      statements.push(
        env.MAIL_DB.prepare(`INSERT INTO mail_events (id, user_id, kind, cursor) VALUES (?, ?, 'new_mail', ?)`).bind(
          crypto.randomUUID(),
          copy.userId,
          copyId,
        ),
      );
    }
  }

  // Re-check the destination mailboxes right before writing anything to R2 so
  // a mailbox deactivated mid-request never receives ciphertext.
  const still = await loadAddressRows(
    env,
    copies.map((copy) => copy.address),
  );
  for (const copy of copies) {
    const row = still.get(copy.address);
    if (!row || row.state !== 'active' || row.user_id !== copy.userId) {
      return error('mail_recipient_changed', 409);
    }
  }

  if (!(await writeStaged(env, staged, statements))) return error('mail_delivery_failed', 500);
  return json({ ok: true, message_id: envelope.messageId, delivered: copies.length });
}

export async function handleInternalSend(env: MailEnv, userId: string, req: Request): Promise<Response> {
  const key = idempotencyKey(req);
  if (!key) return error('mail_idempotency_required');
  const raw = await readJsonBody(req, MAX_SEND_BODY);
  if (!raw) return error('mail_invalid_body');
  const parsed = parseEnvelope(raw);
  if ('error' in parsed) return error(parsed.error, parsed.status);

  if (!(await claimIdempotency(env, userId, key))) return json({ ok: true, duplicate: true });

  const response = await deliver(env, userId, parsed);
  if (!response.ok) {
    // Let a corrected retry reuse the same Idempotency-Key after a failure.
    await env.MAIL_DB.prepare('DELETE FROM mail_idempotency_keys WHERE user_id = ? AND idempotency_key = ?')
      .bind(userId, key)
      .run()
      .catch(() => {});
  }
  return response;
}

// ---------------------------------------------------------------------------
// Drafts (§10: drafts are encrypted and survive reload when the vault is
// unlocked). A draft is a normal message row with direction='draft' and its own
// one-message thread so the mailbox list can keep the folder model.
// ---------------------------------------------------------------------------

const MAX_DRAFT_BODY = MAX_SEND_BODY;

function draftError(code: string, status = 400): Response {
  return error(code, status);
}

async function loadDraft(
  env: MailEnv,
  userId: string,
  draftId: string,
): Promise<{
  id: string;
  blobId: string;
  sizeBytes: number;
  threadId: string;
  attachments: Array<{ id: string; r2_key: string }>;
} | null> {
  const row = await env.MAIL_DB.prepare(
    `SELECT id, blob_id, size_bytes, thread_id FROM mail_messages
     WHERE id = ? AND user_id = ? AND direction = 'draft' AND deleted_at IS NULL`,
  )
    .bind(draftId, userId)
    .first<{ id: string; blob_id: string; size_bytes: number; thread_id: string }>();
  if (!row) return null;
  const attachments = await env.MAIL_DB.prepare(
    'SELECT id, r2_key FROM mail_attachments WHERE message_id = ? AND user_id = ?',
  )
    .bind(draftId, userId)
    .all<{ id: string; r2_key: string }>();
  return {
    id: row.id,
    blobId: row.blob_id,
    sizeBytes: Number(row.size_bytes) || 0,
    threadId: row.thread_id,
    attachments: attachments.results ?? [],
  };
}

function draftRecipientCount(envelope: Envelope): number {
  return new Set([...envelope.to, ...envelope.cc, ...envelope.bcc]).size;
}

/** Drafts may address external recipients even before the SMTP path ships. */
function validateDraftEnvelope(envelope: Envelope): Response | null {
  if (envelope.to.length === 0 && envelope.cc.length === 0 && envelope.bcc.length === 0) {
    // Empty drafts are fine: compose often saves before typing a recipient.
    return null;
  }
  if (draftRecipientCount(envelope) > MAX_RECIPIENTS) return draftError('mail_too_many_recipients');
  if (envelope.keys.length !== 1 || envelope.keys[0]?.address !== envelope.from) {
    return draftError('mail_invalid_keys');
  }
  return null;
}

export async function handleCreateDraft(env: MailEnv, userId: string, req: Request): Promise<Response> {
  const key = idempotencyKey(req);
  if (!key) return error('mail_idempotency_required');
  const raw = await readJsonBody(req, MAX_DRAFT_BODY);
  if (!raw) return error('mail_invalid_body');
  const parsed = parseEnvelope(raw);
  if ('error' in parsed) return error(parsed.error, parsed.status);
  const invalidDraft = validateDraftEnvelope(parsed);
  if (invalidDraft) return invalidDraft;

  const addresses = await loadAddressRows(env, [parsed.from]);
  const sender = addresses.get(parsed.from);
  if (!sender || sender.user_id !== userId || sender.state !== 'active') return error('mail_from_not_owned', 403);

  const identity = (await loadIdentities(env, [userId])).get(userId);
  const selfKey = parsed.keys[0];
  if (!identity || !selfKey) return error('mail_recipient_unknown', 422);
  if (Number(identity.key_version) !== selfKey.keyVersion) return error('mail_key_rotated', 409);

  const usage = await loadUsage(env, [userId]);
  const bytes = storedBytes(parsed);
  if ((usage.get(userId) ?? 0) + bytes > MAX_STORAGE_BYTES) return error('mail_quota_exceeded', 507);

  if (!(await claimIdempotency(env, userId, key))) {
    return json({ ok: true, draft_id: parsed.messageId, duplicate: true });
  }

  const draftId = parsed.messageId;
  const threadId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const payloadKey = `mail/${userId}/${draftId}/payload.enc`;
  const staged: Array<{ key: string; bytes: Uint8Array }> = [
    { key: payloadKey, bytes: b64ToBytes(parsed.payload.ciphertext) },
  ];

  const statements: D1PreparedStatement[] = [
    env.MAIL_DB.prepare(
      `INSERT INTO mail_threads
         (id, user_id, subject_enc, last_message_at, message_count, unread_count, participants_enc, thread_key, folder)
       VALUES (?, ?, ?, ?, 1, 0, '', '', 'drafts')`,
    ).bind(threadId, userId, parsed.subjectEnc, receivedAt),
    env.MAIL_DB.prepare(
      `INSERT INTO mail_messages
         (id, user_id, thread_id, direction, folder, from_addr, to_addr, from_name_enc,
          to_enc, cc_enc, bcc_enc, reply_to_enc, subject_enc, meta_enc,
          message_id_hash, in_reply_to_hash, references_hash, sent_at, received_at,
          size_bytes, has_attachments, read_at, starred_at, security, auth_results,
          spam_score, blob_id, payload_iv, raw_blob_key, deleted_at, aad_id)
       VALUES (?, ?, ?, 'draft', 'drafts', ?, ?, ?, '', '', '', '', ?, ?, ?, ?, '', NULL, ?,
               ?, ?, ?, NULL, 'e2ee', '{}', 0, ?, ?, '', NULL, ?)`,
    ).bind(
      draftId,
      userId,
      threadId,
      parsed.from,
      parsed.to[0] ?? '',
      parsed.fromNameEnc,
      parsed.subjectEnc,
      parsed.metaEnc,
      parsed.messageId,
      parsed.inReplyToHash,
      receivedAt,
      bytes,
      parsed.attachments.length > 0 ? 1 : 0,
      receivedAt,
      payloadKey,
      parsed.payload.iv,
      parsed.messageId,
    ),
    insertKey(env, draftId, parsed.from, selfKey),
    insertBlob(env, draftId, payloadKey, parsed.payload.bytes),
    usageUpsert(env, userId, bytes),
  ];

  for (const [index, attachment] of parsed.attachments.entries()) {
    const rowId = crypto.randomUUID();
    const r2Key = `mail/${userId}/${draftId}/attachments/${rowId}.enc`;
    staged.push({ key: r2Key, bytes: b64ToBytes(attachment.ciphertext) });
    void index;
    statements.push(
      insertAttachment(env, {
        id: rowId,
        messageId: draftId,
        userId,
        filenameEnc: attachment.filenameEnc,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        r2Key,
        aadId: attachment.id,
        iv: attachment.iv,
      }),
    );
  }

  if (!(await writeStaged(env, staged, statements))) {
    await env.MAIL_DB.prepare('DELETE FROM mail_idempotency_keys WHERE user_id = ? AND idempotency_key = ?')
      .bind(userId, key)
      .run()
      .catch(() => {});
    return error('mail_draft_failed', 500);
  }
  return json({ ok: true, draft_id: draftId });
}

export async function handleUpdateDraft(
  env: MailEnv,
  userId: string,
  draftId: string,
  req: Request,
): Promise<Response> {
  if (!ID_PATTERN.test(draftId)) return error('mail_invalid_draft');
  const key = idempotencyKey(req);
  if (!key) return error('mail_idempotency_required');
  const raw = await readJsonBody(req, MAX_DRAFT_BODY);
  if (!raw) return error('mail_invalid_body');
  if (raw.message_id !== draftId) return error('mail_invalid_message');
  const parsed = parseEnvelope(raw);
  if ('error' in parsed) return error(parsed.error, parsed.status);
  const invalidDraft = validateDraftEnvelope(parsed);
  if (invalidDraft) return invalidDraft;

  const existing = await loadDraft(env, userId, draftId);
  if (!existing) return error('mail_draft_not_found', 404);

  const addresses = await loadAddressRows(env, [parsed.from]);
  const sender = addresses.get(parsed.from);
  if (!sender || sender.user_id !== userId || sender.state !== 'active') return error('mail_from_not_owned', 403);

  const identity = (await loadIdentities(env, [userId])).get(userId);
  const selfKey = parsed.keys[0];
  if (!identity || !selfKey) return error('mail_recipient_unknown', 422);
  if (Number(identity.key_version) !== selfKey.keyVersion) return error('mail_key_rotated', 409);

  if (!(await claimIdempotency(env, userId, key))) return json({ ok: true, draft_id: draftId, duplicate: true });

  const bytes = storedBytes(parsed);
  const usage = await loadUsage(env, [userId]);
  if ((usage.get(userId) ?? 0) - existing.sizeBytes + bytes > MAX_STORAGE_BYTES) {
    return error('mail_quota_exceeded', 507);
  }

  const receivedAt = new Date().toISOString();
  const payloadKey = `mail/${userId}/${draftId}/payload.enc`;
  const staged: Array<{ key: string; bytes: Uint8Array }> = [
    { key: payloadKey, bytes: b64ToBytes(parsed.payload.ciphertext) },
  ];
  const obsoleteKeys = existing.attachments.map((attachment) => attachment.r2_key).filter(Boolean);

  const statements: D1PreparedStatement[] = [
    env.MAIL_DB.prepare(
      `UPDATE mail_threads
       SET subject_enc = ?, last_message_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND user_id = ?`,
    ).bind(parsed.subjectEnc, receivedAt, existing.threadId, userId),
    env.MAIL_DB.prepare(
      `UPDATE mail_messages SET
         from_addr = ?, to_addr = ?, from_name_enc = ?, subject_enc = ?, meta_enc = ?,
         message_id_hash = ?, in_reply_to_hash = ?, received_at = ?, size_bytes = ?,
         has_attachments = ?, blob_id = ?, payload_iv = ?
       WHERE id = ? AND user_id = ? AND direction = 'draft' AND deleted_at IS NULL`,
    ).bind(
      parsed.from,
      parsed.to[0] ?? '',
      parsed.fromNameEnc,
      parsed.subjectEnc,
      parsed.metaEnc,
      parsed.messageId,
      parsed.inReplyToHash,
      receivedAt,
      bytes,
      parsed.attachments.length > 0 ? 1 : 0,
      payloadKey,
      parsed.payload.iv,
      draftId,
      userId,
    ),
    env.MAIL_DB.prepare('DELETE FROM mail_attachments WHERE message_id = ? AND user_id = ?').bind(draftId, userId),
    env.MAIL_DB.prepare('DELETE FROM mail_message_keys WHERE message_id = ?').bind(draftId),
    env.MAIL_DB.prepare('DELETE FROM mail_blobs WHERE id = ?').bind(draftId),
    insertKey(env, draftId, parsed.from, selfKey),
    insertBlob(env, draftId, payloadKey, parsed.payload.bytes),
    usageUpsert(env, userId, bytes - existing.sizeBytes),
  ];

  for (const attachment of parsed.attachments) {
    const rowId = crypto.randomUUID();
    const r2Key = `mail/${userId}/${draftId}/attachments/${rowId}.enc`;
    staged.push({ key: r2Key, bytes: b64ToBytes(attachment.ciphertext) });
    statements.push(
      insertAttachment(env, {
        id: rowId,
        messageId: draftId,
        userId,
        filenameEnc: attachment.filenameEnc,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        r2Key,
        aadId: attachment.id,
        iv: attachment.iv,
      }),
    );
  }

  if (!(await writeStaged(env, staged, statements))) return error('mail_draft_failed', 500);
  for (const obsolete of [...obsoleteKeys, existing.blobId]) {
    await env.MAIL_BUCKET.delete(obsolete).catch(() => undefined);
  }
  return json({ ok: true, draft_id: draftId });
}

export async function handleDeleteDraft(env: MailEnv, userId: string, draftId: string): Promise<Response> {
  if (!ID_PATTERN.test(draftId)) return error('mail_invalid_draft');
  const existing = await loadDraft(env, userId, draftId);
  if (!existing) return json({ ok: true, deleted: 0 });

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare('DELETE FROM mail_attachments WHERE message_id = ? AND user_id = ?').bind(draftId, userId),
    env.MAIL_DB.prepare('DELETE FROM mail_message_keys WHERE message_id = ?').bind(draftId),
    env.MAIL_DB.prepare('DELETE FROM mail_blobs WHERE id = ?').bind(draftId),
    env.MAIL_DB.prepare('DELETE FROM mail_messages WHERE id = ? AND user_id = ?').bind(draftId, userId),
    env.MAIL_DB.prepare('DELETE FROM mail_threads WHERE id = ? AND user_id = ?').bind(existing.threadId, userId),
    usageUpsert(env, userId, -existing.sizeBytes),
  ]);

  for (const key of [existing.blobId, ...existing.attachments.map((attachment) => attachment.r2_key)]) {
    if (key) await env.MAIL_BUCKET.delete(key).catch(() => undefined);
  }
  return json({ ok: true, deleted: 1 });
}

export async function handleListDrafts(env: MailEnv, userId: string): Promise<Response> {
  const rows = await env.MAIL_DB.prepare(
    `SELECT m.id, m.from_addr, m.to_addr, m.subject_enc, m.meta_enc, m.payload_iv, m.aad_id,
            m.received_at, m.size_bytes, m.has_attachments,
            k.ephemeral_public_key, k.iv AS key_iv, k.wrapped_content_key, k.key_version, k.recipient_address
     FROM mail_messages m
     LEFT JOIN mail_message_keys k ON k.message_id = m.id AND k.recipient_address = m.from_addr
     WHERE m.user_id = ? AND m.direction = 'draft' AND m.deleted_at IS NULL
     ORDER BY m.received_at DESC
     LIMIT 50`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  return json({
    drafts: (rows.results ?? []).map((row) => ({
      id: row.id,
      from_addr: row.from_addr,
      to_addr: row.to_addr,
      subject_enc: row.subject_enc,
      meta_enc: row.meta_enc,
      payload_iv: row.payload_iv,
      aad_id: row.aad_id,
      received_at: row.received_at,
      size_bytes: row.size_bytes,
      has_attachments: Boolean(row.has_attachments),
      key: row.ephemeral_public_key
        ? {
            ephemeral_public_key: row.ephemeral_public_key,
            iv: row.key_iv,
            wrapped_content_key: row.wrapped_content_key,
            key_version: row.key_version,
            recipient_address: row.recipient_address,
          }
        : null,
    })),
  });
}

export async function handleDraftDetail(env: MailEnv, userId: string, draftId: string): Promise<Response> {
  if (!ID_PATTERN.test(draftId)) return error('mail_invalid_draft');
  const row = await env.MAIL_DB.prepare(
    `SELECT m.*, k.ephemeral_public_key, k.iv AS key_iv, k.wrapped_content_key,
            k.key_version, k.recipient_address
     FROM mail_messages m
     LEFT JOIN mail_message_keys k ON k.message_id = m.id AND k.recipient_address = m.from_addr
     WHERE m.id = ? AND m.user_id = ? AND m.direction = 'draft' AND m.deleted_at IS NULL`,
  )
    .bind(draftId, userId)
    .first<Record<string, unknown>>();
  if (!row) return error('mail_draft_not_found', 404);

  const attachments = await env.MAIL_DB.prepare(
    'SELECT id, aad_id, iv, content_type, size_bytes, scan_status FROM mail_attachments WHERE message_id = ? AND user_id = ?',
  )
    .bind(draftId, userId)
    .all<Record<string, unknown>>();

  return json({
    draft: {
      id: row.id,
      from_addr: row.from_addr,
      to_addr: row.to_addr,
      subject_enc: row.subject_enc,
      meta_enc: row.meta_enc,
      payload_iv: row.payload_iv,
      aad_id: row.aad_id,
      received_at: row.received_at,
      size_bytes: row.size_bytes,
      has_attachments: Boolean(row.has_attachments),
      key: row.ephemeral_public_key
        ? {
            ephemeral_public_key: row.ephemeral_public_key,
            iv: row.key_iv,
            wrapped_content_key: row.wrapped_content_key,
            key_version: row.key_version,
            recipient_address: row.recipient_address,
          }
        : null,
    },
    attachments: attachments.results ?? [],
  });
}

export async function handleDraftPayload(env: MailEnv, userId: string, draftId: string): Promise<Response> {
  if (!ID_PATTERN.test(draftId)) return error('mail_invalid_draft');
  const row = await env.MAIL_DB.prepare(
    `SELECT blob_id FROM mail_messages
     WHERE id = ? AND user_id = ? AND direction = 'draft' AND deleted_at IS NULL`,
  )
    .bind(draftId, userId)
    .first<{ blob_id: string }>();
  if (!row?.blob_id) return error('mail_draft_not_found', 404);
  const object = await env.MAIL_BUCKET.get(row.blob_id);
  if (!object) return error('mail_draft_not_found', 404);
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}

export async function handleDraftAttachment(
  env: MailEnv,
  userId: string,
  draftId: string,
  attachmentId: string,
): Promise<Response> {
  if (!ID_PATTERN.test(draftId) || !ID_PATTERN.test(attachmentId)) return error('mail_invalid_attachment');
  const row = await env.MAIL_DB.prepare(
    `SELECT a.r2_key FROM mail_attachments a
     JOIN mail_messages m ON m.id = a.message_id AND m.user_id = a.user_id
     WHERE a.id = ? AND a.message_id = ? AND a.user_id = ?
       AND m.direction = 'draft' AND m.deleted_at IS NULL`,
  )
    .bind(attachmentId, draftId, userId)
    .first<{ r2_key: string }>();
  if (!row?.r2_key) return error('mail_attachment_not_found', 404);
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return error('mail_attachment_not_found', 404);
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}
