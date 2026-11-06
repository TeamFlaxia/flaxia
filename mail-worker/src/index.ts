/// <reference types="@cloudflare/workers-types" />
// flaxia-mail Worker (docs/mail.md §5). Internal API is Service-Binding-only:
// every fetch() call must carry a valid MAIL_INTERNAL_SECRET HMAC for the
// authenticated user id. The Worker never trusts a bare user id.
import { RESERVED_LOCALS } from '../../src/lib/mail/address.ts';
import { isValidP256SpkiB64, sha256Hex } from './crypto.ts';
import { handleInboundEmail, type MailEnv } from './ingest.ts';

const MIME_MAX = 10 * 1024 * 1024;
const MAX_INTERNAL_BODY = 16 * 1024;
const MAX_KEY_LOOKUP = 50;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

type Json = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(code: string, status = 400): Response {
  return json({ error: code }, status);
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message) as BufferSource);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyInternal(env: MailEnv, req: Request, body: string): Promise<string | null> {
  const userId = req.headers.get('x-flaxia-user-id');
  const ts = req.headers.get('x-flaxia-ts');
  const sig = req.headers.get('x-flaxia-sig');
  const secret = env.MAIL_INTERNAL_SECRET;
  if (!userId || !ts || !sig || !secret) return null;
  // Reject a non-numeric timestamp explicitly: `NaN > 300` is false, which
  // would otherwise skip the skew check entirely.
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return null;
  const url = new URL(req.url);
  // Bind the signature to the exact call, not just the user + timestamp.
  const target = `${req.method.toUpperCase()}.${url.pathname}${url.search}.${await sha256Hex(body)}`;
  const expected = await hmac(secret, `${userId}.${ts}.${target}`);
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < Math.max(expected.length, sig.length); i++) {
    diff |= (expected.charCodeAt(i) || 0) ^ (sig.charCodeAt(i) || 0);
  }
  return diff === 0 ? userId : null;
}

function idempotencyKey(req: Request): string | null {
  const value = req.headers.get('Idempotency-Key');
  return value && IDEMPOTENCY_PATTERN.test(value) ? value : null;
}

async function claimIdempotency(env: MailEnv, userId: string, key: string): Promise<boolean> {
  const result = await env.MAIL_DB.prepare(
    'INSERT OR IGNORE INTO mail_idempotency_keys (user_id, idempotency_key) VALUES (?, ?)',
  )
    .bind(userId, key)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;

  // Opportunistic retention sweep; the table is operational, not archival.
  await env.MAIL_DB.prepare(
    `DELETE FROM mail_idempotency_keys
     WHERE user_id = ? AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`,
  )
    .bind(userId)
    .run()
    .catch(() => {});
  return true;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254) return null;
  const at = normalized.lastIndexOf('@');
  if (at < 1) return null;
  const local = normalized.slice(0, at);
  if (!/^[A-Za-z0-9_]{1,20}$/.test(local)) return null;
  if (RESERVED_LOCALS.has(local)) return null;
  return normalized;
}

function addressMatchesDomain(address: string, env: MailEnv): boolean {
  const domain = (env.MAIL_DOMAIN ?? 'flaxia.app').toLowerCase();
  return address.endsWith(`@${domain}`);
}

async function readJson(req: Request): Promise<Json | null> {
  const text = await req.text();
  if (text.length === 0 || text.length > MAX_INTERNAL_BODY) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Json;
  } catch {
    return null;
  }
}

function parseKeyVersion(value: unknown): number | null {
  const version = Number(value ?? 1);
  return Number.isInteger(version) && version >= 1 && version <= 1_000_000 ? version : null;
}

async function listAddresses(env: MailEnv, userId: string): Promise<Response> {
  const rows = await env.MAIL_DB.prepare(
    'SELECT address, kind, state FROM mail_addresses WHERE user_id = ? ORDER BY created_at ASC',
  )
    .bind(userId)
    .all<{ address: string; kind: string; state: string }>();
  return json({ addresses: rows.results ?? [] });
}

async function activateAddress(env: MailEnv, userId: string, req: Request): Promise<Response> {
  if (!idempotencyKey(req)) return error('mail_idempotency_required', 400);
  const body = await readJson(req);
  if (!body) return error('mail_invalid_body');

  const address = normalizeAddress(body.address);
  if (!address || !addressMatchesDomain(address, env)) return error('mail_invalid_address');

  await env.MAIL_DB.prepare(
    `DELETE FROM mail_reserved_addresses
     WHERE release_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run();
  const reserved = await env.MAIL_DB.prepare(
    `SELECT 1 FROM mail_reserved_addresses
     WHERE address = ? AND release_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(address)
    .first();
  if (reserved) return error('mail_address_reserved', 409);

  const publicKey = body.public_key;
  if (typeof publicKey !== 'string' || !(await isValidP256SpkiB64(publicKey))) {
    return error('mail_invalid_public_key');
  }

  const keyVersion = parseKeyVersion(body.key_version);
  if (keyVersion === null) return error('mail_invalid_key_version');

  // Key history is append-only: activation must not downgrade a version or
  // silently replace the key at an existing version. A changed key requires a
  // new key_version (rotation).
  const existingIdentity = await env.MAIL_DB.prepare(
    'SELECT public_key, key_version FROM mail_identities WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ public_key: string; key_version: number }>();
  if (existingIdentity) {
    if (keyVersion < Number(existingIdentity.key_version)) return error('mail_stale_key_version', 409);
    if (keyVersion === Number(existingIdentity.key_version) && publicKey !== existingIdentity.public_key) {
      return error('mail_key_version_conflict', 409);
    }
  }

  const owner = await env.MAIL_DB.prepare('SELECT user_id FROM mail_addresses WHERE address = ?')
    .bind(address)
    .first<{ user_id: string }>();
  if (owner && owner.user_id !== userId) return error('mail_address_taken', 409);

  const inserted = await env.MAIL_DB.prepare(
    `INSERT INTO mail_addresses (address, user_id, kind, state)
     VALUES (?, ?, 'primary', 'active')
     ON CONFLICT(address) DO UPDATE SET state = 'active', disabled_at = NULL
     WHERE mail_addresses.user_id = excluded.user_id`,
  )
    .bind(address, userId)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return error('mail_address_taken', 409);

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `INSERT INTO mail_identities (user_id, address, public_key, key_version, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         address = excluded.address,
         public_key = excluded.public_key,
         key_version = excluded.key_version,
         updated_at = excluded.updated_at`,
    ).bind(userId, address, publicKey, keyVersion),
    env.MAIL_DB.prepare(
      `INSERT INTO mail_identity_versions (user_id, key_version, public_key)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, key_version) DO UPDATE SET public_key = excluded.public_key`,
    ).bind(userId, keyVersion, publicKey),
  ]);

  return json({ address, key_version: keyVersion }, 201);
}

async function getMyKey(env: MailEnv, userId: string): Promise<Response> {
  const row = await env.MAIL_DB.prepare(
    `SELECT i.address, i.public_key, i.key_version
     FROM mail_identities i
     JOIN mail_addresses a ON a.user_id = i.user_id AND a.address = i.address
     WHERE i.user_id = ? AND a.state = 'active'
     LIMIT 1`,
  )
    .bind(userId)
    .first<{ address: string; public_key: string; key_version: number }>();
  if (!row) return error('mail_not_activated', 404);
  return json(row);
}

async function publishMyKey(env: MailEnv, userId: string, req: Request): Promise<Response> {
  if (!idempotencyKey(req)) return error('mail_idempotency_required', 400);
  const body = await readJson(req);
  if (!body) return error('mail_invalid_body');

  const publicKey = body.public_key;
  if (typeof publicKey !== 'string' || !(await isValidP256SpkiB64(publicKey))) {
    return error('mail_invalid_public_key');
  }

  const keyVersion = parseKeyVersion(body.key_version);
  if (keyVersion === null) return error('mail_invalid_key_version');

  const current = await env.MAIL_DB.prepare(
    `SELECT i.address, i.public_key, i.key_version
     FROM mail_identities i
     JOIN mail_addresses a ON a.user_id = i.user_id AND a.address = i.address
     WHERE i.user_id = ? AND a.state = 'active'
     LIMIT 1`,
  )
    .bind(userId)
    .first<{ address: string; public_key: string; key_version: number }>();
  if (!current) return error('mail_not_activated', 409);
  if (keyVersion < Number(current.key_version)) return error('mail_stale_key_version', 409);
  if (keyVersion === Number(current.key_version) && publicKey !== current.public_key) {
    return error('mail_key_version_conflict', 409);
  }

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `UPDATE mail_identities
       SET public_key = ?, key_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?`,
    ).bind(publicKey, keyVersion, userId),
    env.MAIL_DB.prepare(
      `INSERT INTO mail_identity_versions (user_id, key_version, public_key)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, key_version) DO UPDATE SET public_key = excluded.public_key`,
    ).bind(userId, keyVersion, publicKey),
  ]);

  return json({ address: current.address, key_version: keyVersion });
}

async function lookupKeys(env: MailEnv, url: URL): Promise<Response> {
  const requested = (url.searchParams.get('addresses') ?? '')
    .split(',')
    .map((value) => normalizeAddress(value))
    .filter((value): value is string => value !== null && addressMatchesDomain(value, env));
  if (requested.length === 0) return json({ keys: [] });
  if (requested.length > MAX_KEY_LOOKUP) return error('mail_too_many_addresses');

  const rows = await env.MAIL_DB.prepare(
    `SELECT i.address, i.public_key, i.key_version
     FROM mail_identities i
     JOIN mail_addresses a ON a.user_id = i.user_id AND a.address = i.address
     WHERE a.state = 'active'
       AND i.address IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(requested))
    .all<{ address: string; public_key: string; key_version: number }>();
  return json({ keys: rows.results ?? [] });
}

async function reportAbuse(env: MailEnv, userId: string, req: Request): Promise<Response> {
  const key = idempotencyKey(req);
  if (!key) return error('mail_idempotency_required', 400);
  const body = await readJson(req);
  if (!body) return error('mail_invalid_body');
  const messageId = typeof body.message_id === 'string' ? body.message_id.trim() : '';
  if (messageId.length > 128) return error('mail_invalid_message_id');

  // A report may only reference a message in the caller's own mailbox.
  if (messageId) {
    const owned = await env.MAIL_DB.prepare('SELECT 1 FROM mail_messages WHERE id = ? AND user_id = ?')
      .bind(messageId, userId)
      .first();
    if (!owned) return error('mail_message_not_found', 404);
  }

  // A retried report must not create duplicate events.
  if (!(await claimIdempotency(env, userId, key))) return json({ ok: true }, 202);

  await env.MAIL_DB.prepare('INSERT INTO mail_events (id, user_id, kind, cursor) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, 'abuse_report', messageId)
    .run();
  return json({ ok: true }, 202);
}

async function unread(env: MailEnv, userId: string): Promise<Response> {
  const row = await env.MAIL_DB.prepare(
    'SELECT COALESCE(SUM(unread_count), 0) AS unread FROM mail_threads WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ unread: number }>();
  return json({ unread: Number(row?.unread ?? 0) });
}

async function deleteUserData(env: MailEnv, userId: string): Promise<Response> {
  // User ids are database identifiers; reject path/prefix injection anyway
  // because this id is interpolated into an R2 prefix.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return error('mail_invalid_user', 400);
  // Use the user id as the job id so outbox retries reuse one row instead of
  // accumulating failed jobs.
  const jobId = userId;
  await env.MAIL_DB.prepare(
    `INSERT INTO mail_deletion_jobs (id, user_id, state) VALUES (?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET state = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(jobId, userId)
    .run();

  try {
    const addressRows = await env.MAIL_DB.prepare('SELECT address FROM mail_addresses WHERE user_id = ?')
      .bind(userId)
      .all<{ address: string }>();
    const addresses = addressRows.results ?? [];

    const keys = new Set<string>();
    const messageRows = await env.MAIL_DB.prepare('SELECT blob_id, raw_blob_key FROM mail_messages WHERE user_id = ?')
      .bind(userId)
      .all<{ blob_id: string; raw_blob_key: string }>();
    for (const row of messageRows.results ?? []) {
      if (row.blob_id) keys.add(row.blob_id);
      if (row.raw_blob_key) keys.add(row.raw_blob_key);
    }
    const attachmentRows = await env.MAIL_DB.prepare('SELECT r2_key FROM mail_attachments WHERE user_id = ?')
      .bind(userId)
      .all<{ r2_key: string }>();
    for (const row of attachmentRows.results ?? []) if (row.r2_key) keys.add(row.r2_key);

    const statements: D1PreparedStatement[] = [
      env.MAIL_DB.prepare(
        'DELETE FROM mail_message_keys WHERE message_id IN (SELECT id FROM mail_messages WHERE user_id = ?)',
      ).bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_message_labels WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_attachments WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_messages WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_threads WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_labels WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_identities WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_identity_versions WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_addresses WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_usage WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_events WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_outbound_jobs WHERE user_id = ?').bind(userId),
      env.MAIL_DB.prepare('DELETE FROM mail_idempotency_keys WHERE user_id = ?').bind(userId),
    ];

    // Keep the address unusable for 90 days (docs/mail.md §11.3).
    for (const address of addresses) {
      statements.push(
        env.MAIL_DB.prepare(
          `INSERT INTO mail_reserved_addresses (address, release_at)
           VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days'))
           ON CONFLICT(address) DO UPDATE SET release_at = excluded.release_at`,
        ).bind(address.address),
      );
    }

    // Delete D1 rows first: removing the addresses stops new ingest before the
    // R2 sweep, so an in-flight message cannot repopulate the prefix after it.
    await env.MAIL_DB.batch(statements);

    // Sweep the prefix after D1 deletion to catch objects whose row was lost
    // or written by an ingest that started before the address was removed.
    let cursor: string | undefined;
    do {
      const listed = await env.MAIL_BUCKET.list({ prefix: `mail/${userId}/`, cursor });
      for (const object of listed.objects) keys.add(object.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    const allKeys = [...keys];
    for (let index = 0; index < allKeys.length; index += 1000) {
      await env.MAIL_BUCKET.delete(allKeys.slice(index, index + 1000));
    }

    // Only clear the job after both stores are clean so a failure is visible.
    await env.MAIL_DB.prepare('DELETE FROM mail_deletion_jobs WHERE id = ?').bind(jobId).run();
    return json({ ok: true });
  } catch (err) {
    const message = String((err as Error)?.message ?? 'mail_deletion_failed').slice(0, 200);
    await env.MAIL_DB.prepare(
      `UPDATE mail_deletion_jobs
       SET state = 'failed', attempts = attempts + 1, last_error = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    )
      .bind(message, jobId)
      .run()
      .catch(() => {});
    return error('mail_deletion_failed', 500);
  }
}

async function quota(env: MailEnv, userId: string): Promise<Response> {
  const row = await env.MAIL_DB.prepare(
    'SELECT storage_bytes, external_sends, external_day FROM mail_usage WHERE user_id = ?',
  )
    .bind(userId)
    .first();
  const today = new Date().toISOString().slice(0, 10);
  const sends = row?.external_day === today ? Number((row as Record<string, unknown>)?.external_sends ?? 0) : 0;
  return json({
    storage_bytes: Number((row as Record<string, unknown>)?.storage_bytes ?? 0),
    storage_quota_bytes: 512 * 1024 * 1024,
    external_sends: sends,
    daily_external_limit: 20,
  });
}

async function handleInternal(env: MailEnv, req: Request, userId: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/internal/quota') return quota(env, userId);
  if (method === 'GET' && url.pathname === '/internal/unread') return unread(env, userId);
  if (method === 'GET' && url.pathname === '/internal/addresses') return listAddresses(env, userId);
  if (method === 'POST' && url.pathname === '/internal/addresses') return activateAddress(env, userId, req);
  if (method === 'GET' && url.pathname === '/internal/keys/me') return getMyKey(env, userId);
  if (method === 'PUT' && url.pathname === '/internal/keys/me') return publishMyKey(env, userId, req);
  if (method === 'GET' && url.pathname === '/internal/keys') return lookupKeys(env, url);
  if (method === 'POST' && url.pathname === '/internal/report-abuse') return reportAbuse(env, userId, req);
  if (method === 'DELETE' && url.pathname === '/internal/delete-user') return deleteUserData(env, userId);

  return error('mail_not_implemented', 501);
}

export default {
  async fetch(req: Request, env: MailEnv): Promise<Response> {
    const url = new URL(req.url);
    // Health is unauthenticated but the Worker is only reachable through the
    // service binding (workers_dev is disabled), never the public internet.
    if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true });

    // The signature covers the body hash, so read it from a clone and let the
    // endpoint consume the original stream normally.
    const body = await req
      .clone()
      .text()
      .catch(() => '');
    const userId = await verifyInternal(env, req, body);
    if (!userId) return error('mail_unauthorized', 401);
    return handleInternal(env, req, userId);
  },

  async email(message: ForwardableEmailMessage, env: MailEnv): Promise<void> {
    // P1 kill switch: do not accept live user mail before P2 (MIME auth,
    // attachment scanning, threading, and a read UI). This bounds the blast
    // radius if Email Routing is pointed at the Worker too early.
    if (env.MAIL_INBOUND_ENABLED !== '1') {
      message.setReject('Mailbox is not accepting mail yet');
      return;
    }
    // Cloudflare Email Routing -> email() handler. Size-guard before buffering.
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      if (raw.byteLength > MIME_MAX) {
        message.setReject('Message too large');
        return;
      }
      await handleInboundEmail(env, raw, message.to);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 550) {
        message.setReject('No such recipient');
        return;
      }
      if (code === 552) {
        message.setReject('Mailbox quota exceeded');
        return;
      }
      throw err;
    }
  },

  async queue(batch: MessageBatch): Promise<void> {
    for (const msg of batch.messages) {
      try {
        // P1: no queue work yet; ack. P2 wires scan/index jobs here.
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<MailEnv>;
