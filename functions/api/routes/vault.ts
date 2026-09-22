// Personal vault key storage (docs/e2ee.md).
//
// The server stores wrapped key material and nothing else: no password, no
// KEK/REK/VK, no recovery phrase. Handlers shape-check the opaque strings so a
// malformed value is rejected early, but they can never interpret one — the
// allowlists below are the entire server-side "understanding" of this data.
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { isValidB64, isValidVaultKdfParams, isValidWrappedKey } from '../../../src/lib/vault/primitives';
import { verifySrpPassword } from '../../lib/auth';
import { requireAuth } from '../helpers';
import type { Bindings, SrpProofBody, Variables } from '../types';

const vault = new Hono<{ Bindings: Bindings; Variables: Variables }>();

interface VaultEnvelopeRow {
  salt: string;
  recovery_salt: string;
  kdf_params: string;
  wrapped_vk: string;
  recovery_blob: string;
  vk_version: number;
}

interface EnvelopeBody {
  salt?: unknown;
  recovery_salt?: unknown;
  kdf_params?: unknown;
  wrapped_vk?: unknown;
  recovery_blob?: unknown;
}

function validateEnvelope(body: EnvelopeBody): string | null {
  if (!isValidB64(body.salt, 16)) return 'Invalid vault salt';
  if (!isValidB64(body.recovery_salt, 16)) return 'Invalid recovery salt';
  if (!isValidVaultKdfParams(body.kdf_params)) return 'Unsupported vault KDF parameters';
  if (!isValidWrappedKey(body.wrapped_vk)) return 'Invalid wrapped vault key';
  if (!isValidWrappedKey(body.recovery_blob)) return 'Invalid recovery blob';
  return null;
}

async function readEnvelope(c: { env: { DB: D1Database } }, userId: string): Promise<VaultEnvelopeRow | null> {
  const row = (await c.env.DB.prepare(
    `SELECT salt, recovery_salt, kdf_params, wrapped_vk, recovery_blob, vk_version
     FROM vault_keys WHERE user_id = ?`,
  )
    .bind(userId)
    .first<VaultEnvelopeRow>()) as VaultEnvelopeRow | null;
  return row ?? null;
}

async function readDevices(
  c: { env: { DB: D1Database } },
  userId: string,
): Promise<Array<{ id: string; label: string; state: string; created_at: string }>> {
  const result = await c.env.DB.prepare(
    'SELECT id, label, state, created_at FROM device_keys WHERE user_id = ? ORDER BY created_at',
  )
    .bind(userId)
    .all<{ id: string; label: string; state: string; created_at: string }>();
  return result.results ?? [];
}

/** One pending pairing per user at a time would be nicer UX but is not a security property. */
const MAX_ACTIVE_DEVICES = 10;
/** A QR left on screen should stop working quickly; clients may ask for less. */
const DEFAULT_PAIRING_TTL_SECONDS = 600;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

interface DeviceRow {
  id: string;
  user_id: string;
  label: string;
  state: 'pending' | 'active';
  peer_pub: string;
  approved_pub: string;
  wrapped_vk: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
}

function isValidLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40;
}

/** Seconds until the QR stops working: 1s..600s, default 600s. */
function pairingExpiry(ttlSeconds: unknown): string {
  const requested =
    typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
      ? Math.floor(ttlSeconds)
      : DEFAULT_PAIRING_TTL_SECONDS;
  const ttl = Math.min(Math.max(requested, 1), DEFAULT_PAIRING_TTL_SECONDS);
  return new Date(Date.now() + ttl * 1000).toISOString();
}

// Replacing the envelope is what recovery-phrase rotation does. It requires an
// SRP proof: a stolen session must not be able to burn the user's recovery
// path by overwriting the blob with one the attacker chose.
async function verifyProof(env: Bindings, userId: string, proof: SrpProofBody | undefined): Promise<boolean> {
  if (!proof?.challenge_id || !proof.A || !proof.M1) return false;
  return verifySrpPassword(env, userId, proof.challenge_id, proof.A, proof.M1);
}

/** Shape check only: separates a malformed request (400) from a bad proof (401). */
function hasProofShape(proof: SrpProofBody | undefined): boolean {
  return Boolean(proof?.challenge_id && proof.A && proof.M1);
}

// GET /vault/keys — everything the client needs to unlock an existing vault.
// The values are all wrapped, so returning them reveals nothing to a caller
// who lacks the password, the phrase, or an approved device.
vault.get('/vault/keys', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await readEnvelope(c, user.id);
  if (!row) return c.json({ enabled: false });

  const parsedParams = JSON.parse(row.kdf_params) as unknown;
  return c.json({
    enabled: true,
    salt: row.salt,
    recovery_salt: row.recovery_salt,
    kdf_params: parsedParams,
    wrapped_vk: row.wrapped_vk,
    recovery_blob: row.recovery_blob,
    vk_version: row.vk_version,
    devices: await readDevices(c, user.id),
  });
});

// POST /vault/keys — enable the vault (SRP accounts only: without a verifier
// there is no way to prove the password, and sending it is forbidden).
vault.post('/vault/keys', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as EnvelopeBody & { current_srp?: SrpProofBody };
  const envelopeError = validateEnvelope(body);
  if (envelopeError) return c.json({ error: envelopeError }, 400);

  if (!hasProofShape(body.current_srp)) {
    return c.json({ error: 'Current password proof is required' }, 400);
  }
  if (!(await verifyProof(c.env, user.id, body.current_srp))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const existing = await c.env.DB.prepare('SELECT user_id FROM vault_keys WHERE user_id = ?').bind(user.id).first();
  if (existing) return c.json({ error: 'Vault already enabled' }, 409);

  const result = await c.env.DB.prepare(
    `INSERT INTO vault_keys (user_id, salt, recovery_salt, kdf_params, wrapped_vk, recovery_blob, vk_version)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      user.id,
      body.salt as string,
      body.recovery_salt as string,
      JSON.stringify(body.kdf_params),
      body.wrapped_vk as string,
      body.recovery_blob as string,
    )
    .run();
  if (!result.success) return c.json({ error: 'Failed to enable vault' }, 500);

  return c.json({ enabled: true, vk_version: 1 }, 201);
});

// PUT /vault/keys — replace the envelope (recovery phrase rotation).
vault.put('/vault/keys', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as EnvelopeBody & {
    current_srp?: SrpProofBody;
    vk_version?: unknown;
  };
  const envelopeError = validateEnvelope(body);
  if (envelopeError) return c.json({ error: envelopeError }, 400);

  if (!hasProofShape(body.current_srp)) {
    return c.json({ error: 'Current password proof is required' }, 400);
  }
  if (!(await verifyProof(c.env, user.id, body.current_srp))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const current = await readEnvelope(c, user.id);
  if (!current) return c.json({ error: 'Vault not enabled' }, 404);

  // A stale client must not silently downgrade the version it cannot produce.
  if (body.vk_version !== undefined && body.vk_version !== current.vk_version) {
    return c.json({ error: 'Vault key version conflict' }, 409);
  }

  const result = await c.env.DB.prepare(
    `UPDATE vault_keys
     SET salt = ?, recovery_salt = ?, kdf_params = ?, wrapped_vk = ?, recovery_blob = ?,
         vk_version = vk_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`,
  )
    .bind(
      body.salt as string,
      body.recovery_salt as string,
      JSON.stringify(body.kdf_params),
      body.wrapped_vk as string,
      body.recovery_blob as string,
      user.id,
    )
    .run();
  if (!result.success) return c.json({ error: 'Failed to update vault keys' }, 500);
  if (result.meta.changes === 0) return c.json({ error: 'Vault not found' }, 404);

  return c.json({ enabled: true });
});

// ─── QR device pairing ────────────────────────────────────────────────────────
//
// Joiner (new device) creates a pending row holding only its *public* ephemeral
// key, shows that id in a QR code, and polls. An existing device scans the QR
// and approves it with VK wrapped under an ECDH+HKDF secret derived from the
// two ephemerals. None of that secret reaches this server — a row is only ever
// an opaque handoff blob.

async function readDevice(c: { env: { DB: D1Database } }, userId: string, deviceId: string): Promise<DeviceRow | null> {
  const row = (await c.env.DB.prepare('SELECT * FROM device_keys WHERE id = ? AND user_id = ?')
    .bind(deviceId, userId)
    .first<DeviceRow>()) as DeviceRow | null;
  return row ?? null;
}

function isExpired(row: DeviceRow): boolean {
  // D1 writes `strftime(...)` and JS writes `toISOString()`; both are
  // `YYYY-MM-DDTHH:mm:ss.sssZ`, so a lexicographic compare is a time compare.
  return row.expires_at <= new Date().toISOString();
}

// POST /vault/devices — joiner starts a pairing (vault must be enabled).
vault.post('/vault/devices', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    label?: unknown;
    peer_pub?: unknown;
    ttl_seconds?: unknown;
  };
  if (!isValidLabel(body.label)) return c.json({ error: 'Invalid device label' }, 400);
  if (!isValidB64(body.peer_pub, 32)) return c.json({ error: 'Invalid pairing public key' }, 400);

  if (!(await readEnvelope(c, user.id))) return c.json({ error: 'vault_not_enabled' }, 409);

  // Reap this user's abandoned QRs before enforcing the cap on live ones.
  await c.env.DB.prepare(`DELETE FROM device_keys WHERE user_id = ? AND state = 'pending' AND expires_at < ${NOW_SQL}`)
    .bind(user.id)
    .run();

  const active = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM device_keys WHERE user_id = ? AND state = 'active'`)
    .bind(user.id)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_DEVICES) return c.json({ error: 'Device limit reached' }, 409);

  const id = nanoid();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO device_keys (id, user_id, label, state, peer_pub, wrapped_vk, expires_at)
     VALUES (?, ?, ?, 'pending', ?, '', ?)`,
  )
    .bind(id, user.id, body.label.trim(), body.peer_pub as string, pairingExpiry(body.ttl_seconds))
    .run();
  if (!inserted.success) return c.json({ error: 'Failed to start pairing' }, 500);

  const row = await readDevice(c, user.id, id);
  return c.json({ id, expires_at: row?.expires_at ?? null }, 201);
});

// GET /vault/devices — management list (no blobs: they are per-pairing anyway).
vault.get('/vault/devices', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await c.env.DB.prepare(
    `SELECT id, label, state, created_at, expires_at, last_seen_at
     FROM device_keys WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all<Pick<DeviceRow, 'id' | 'label' | 'state' | 'created_at' | 'expires_at' | 'last_seen_at'>>();
  return c.json({ devices: result.results ?? [] });
});

// GET /vault/devices/:id — what the joiner polls until approval or expiry.
vault.get('/vault/devices/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const deviceId = c.req.param('id') ?? '';
  const row = await readDevice(c, user.id, deviceId);
  if (!row) return c.json({ error: 'Pairing not found' }, 404);

  if (row.state === 'pending') {
    if (isExpired(row)) return c.json({ id: row.id, state: 'expired', expires_at: row.expires_at });
    return c.json({ id: row.id, state: 'pending', label: row.label, expires_at: row.expires_at });
  }

  return c.json({
    id: row.id,
    state: 'active',
    label: row.label,
    approved_pub: row.approved_pub,
    wrapped_vk: row.wrapped_vk,
  });
});

// POST /vault/devices/:id/approve — existing device hands VK to the joiner.
// Scanning the QR is the second factor: a stolen session alone cannot approve,
// because the approver must read a code displayed on the device being added.
vault.post('/vault/devices/:id/approve', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { approved_pub?: unknown; wrapped_vk?: unknown };
  if (!isValidB64(body.approved_pub, 32)) return c.json({ error: 'Invalid pairing public key' }, 400);
  if (!isValidWrappedKey(body.wrapped_vk)) return c.json({ error: 'Invalid wrapped vault key' }, 400);

  const deviceId = c.req.param('id') ?? '';
  const row = await readDevice(c, user.id, deviceId);
  if (!row) return c.json({ error: 'Pairing not found' }, 404);
  if (row.state !== 'pending') return c.json({ error: 'pairing_already_used' }, 409);
  if (isExpired(row)) return c.json({ error: 'pairing_expired' }, 410);

  const updated = await c.env.DB.prepare(
    `UPDATE device_keys
     SET state = 'active', approved_pub = ?, wrapped_vk = ?, last_seen_at = ${NOW_SQL}
     WHERE id = ? AND user_id = ? AND state = 'pending'`,
  )
    .bind(body.approved_pub as string, body.wrapped_vk as string, row.id, user.id)
    .run();
  if (!updated.success || updated.meta.changes === 0) {
    return c.json({ error: 'pairing_already_used' }, 409);
  }
  return c.json({ ok: true });
});

// DELETE /vault/devices/:id — revoke a device. Its copy of VK stops mattering
// only together with a VK rotation (rewrap of every item key); this removes the
// row so the device cannot re-unlock after a reload.
vault.delete('/vault/devices/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const removed = await c.env.DB.prepare('DELETE FROM device_keys WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id') ?? '', user.id)
    .run();
  if (!removed.success || removed.meta.changes === 0) return c.json({ error: 'Pairing not found' }, 404);
  return c.json({ ok: true });
});

export default vault;
