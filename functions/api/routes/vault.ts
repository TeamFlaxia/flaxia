// Personal vault key storage (docs/e2ee.md).
//
// The server stores wrapped key material and nothing else: no password, no
// KEK/REK/VK, no recovery phrase. Handlers shape-check the opaque strings so a
// malformed value is rejected early, but they can never interpret one — the
// allowlists below are the entire server-side "understanding" of this data.
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import {
  isValidB64,
  isValidVaultItemId,
  isValidVaultKdfParams,
  isValidWrappedKey,
  PAIRING_ID_PATTERN,
} from '../../../src/lib/vault/primitives';
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
/** Vault items are for small personal records; media belongs in encrypted local storage. */
const MAX_VAULT_ITEM_CIPHERTEXT_CHARS = 128_000;
const MAX_VAULT_ITEMS = 200;
const MAX_VAULT_STORAGE_CHARS = 5_000_000;
const VAULT_ITEM_KINDS = new Set(['post_autosave', 'post_draft', 'private_note', 'personal_setting']);
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

  const body = (await c.req.json().catch(() => ({}))) as EnvelopeBody & {
    current_srp?: SrpProofBody;
    device_id?: unknown;
    device_label?: unknown;
  };
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

  // Optional self-registration of the enabling device. The id is chosen by
  // the client so its local record and this row are the same record — without
  // a row there would be nothing to revoke later (threat T4). Shapes only:
  // a label and an opaque id, never a key.
  const deviceId = body.device_id;
  const deviceLabel = body.device_label;
  if (deviceId !== undefined || deviceLabel !== undefined) {
    if (!(typeof deviceId === 'string' && PAIRING_ID_PATTERN.test(deviceId)) || !isValidLabel(deviceLabel)) {
      return c.json({ error: 'Invalid device registration' }, 400);
    }
  }

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO vault_keys (user_id, salt, recovery_salt, kdf_params, wrapped_vk, recovery_blob, vk_version)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).bind(
      user.id,
      body.salt as string,
      body.recovery_salt as string,
      JSON.stringify(body.kdf_params),
      body.wrapped_vk as string,
      body.recovery_blob as string,
    ),
  ];
  if (typeof deviceId === 'string' && typeof deviceLabel === 'string') {
    // OR IGNORE: the id is client-generated and must never displace another
    // user's row if two accounts somehow collided on one (16 random bytes).
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO device_keys (id, user_id, label, state, peer_pub, wrapped_vk, expires_at, last_seen_at)
         VALUES (?, ?, ?, 'active', '', '', '', ${NOW_SQL})`,
      ).bind(deviceId, user.id, deviceLabel),
    );
  }

  const results = await c.env.DB.batch(statements);
  if (results.some((r) => !r.success)) return c.json({ error: 'Failed to enable vault' }, 500);

  return c.json({ enabled: true, vk_version: 1, device_id: deviceId ?? null }, 201);
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
  // vk_version is REQUIRED and must be the integer the client last saw.
  // Missing/fractional/non-numeric is a shape problem (400); a stale-but-valid
  // integer is a conflict (409 below). Skipping it entirely would let any
  // client bypass the optimistic lock.
  if (!Number.isInteger(body.vk_version)) return c.json({ error: 'Invalid vault key version' }, 400);

  if (!hasProofShape(body.current_srp)) {
    return c.json({ error: 'Current password proof is required' }, 400);
  }
  if (!(await verifyProof(c.env, user.id, body.current_srp))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const current = await readEnvelope(c, user.id);
  if (!current) return c.json({ error: 'Vault not enabled' }, 404);

  // A stale client must not silently downgrade the version it cannot produce.
  if (body.vk_version !== current.vk_version) {
    return c.json({ error: 'Vault key version conflict' }, 409);
  }

  // This route re-wraps the same VK (for example, a recovery phrase change),
  // so item-key ciphertext stays valid. Advance item row versions atomically
  // with the envelope to keep unlocked clients from mistaking them as stale.
  const version = body.vk_version as number;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE vault_keys
       SET salt = ?, recovery_salt = ?, kdf_params = ?, wrapped_vk = ?, recovery_blob = ?,
           vk_version = vk_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ? AND vk_version = ?`,
    ).bind(
      body.salt as string,
      body.recovery_salt as string,
      JSON.stringify(body.kdf_params),
      body.wrapped_vk as string,
      body.recovery_blob as string,
      user.id,
      version,
    ),
    c.env.DB.prepare(
      `UPDATE vault_items SET vk_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ? AND vk_version = ?
         AND EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ?)`,
    ).bind(version + 1, user.id, version, user.id, version + 1),
  ]);
  if (results.some((result) => !result.success)) return c.json({ error: 'Failed to update vault keys' }, 500);
  if (results[0].meta.changes === 0) return c.json({ error: 'Vault key version conflict' }, 409);

  return c.json({ enabled: true, vk_version: version + 1 });
});

// GET /vault/items — item-key inventory for rotation. Supplying a kind also
// returns that kind's opaque payloads to the unlocked client.
vault.get('/vault/items', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const kind = c.req.query('kind');
  if (kind !== undefined && !VAULT_ITEM_KINDS.has(kind)) return c.json({ error: 'Invalid vault item kind' }, 400);
  const result = await c.env.DB.prepare(
    `SELECT id, item_key_wrapped, ${kind ? 'payload,' : ''} kind, vk_version, created_at, updated_at
     FROM vault_items WHERE user_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY created_at`,
  )
    .bind(...(kind ? [user.id, kind] : [user.id]))
    .all<{
      id: string;
      item_key_wrapped: string;
      payload?: string;
      kind: string;
      vk_version: number;
      created_at: string;
      updated_at: string;
    }>();
  return c.json({ items: result.results ?? [] });
});

function validVaultItemBody(body: Record<string, unknown>): body is Record<string, unknown> & {
  item_key_wrapped: string;
  payload: string;
  kind: string;
  vk_version: number;
} {
  return (
    isValidWrappedKey(body.item_key_wrapped) &&
    typeof body.payload === 'string' &&
    body.payload.length <= MAX_VAULT_ITEM_CIPHERTEXT_CHARS &&
    isValidWrappedKey(body.payload) &&
    typeof body.kind === 'string' &&
    VAULT_ITEM_KINDS.has(body.kind) &&
    Number.isInteger(body.vk_version) &&
    (body.vk_version as number) > 0
  );
}

// PUT /vault/items/:id — create or replace one encrypted personal item.
// vk_version is an optimistic lock: a client with a stale VK cannot write an
// envelope that appears current after another device rotated the vault.
vault.put('/vault/items/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id') ?? '';
  if (!isValidVaultItemId(id)) return c.json({ error: 'Invalid vault item id' }, 400);
  const parsed = await c.req.json().catch(() => null);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return c.json({ error: 'Invalid vault item' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  if (!validVaultItemBody(body)) return c.json({ error: 'Invalid vault item' }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO vault_items (user_id, id, item_key_wrapped, payload, kind, vk_version)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ?)
       AND (
         EXISTS (SELECT 1 FROM vault_items WHERE user_id = ? AND id = ?)
         OR (SELECT COUNT(*) FROM vault_items WHERE user_id = ?) < ${MAX_VAULT_ITEMS}
       )
       AND (
         (SELECT COALESCE(SUM(length(item_key_wrapped) + length(payload)), 0)
          FROM vault_items WHERE user_id = ? AND id <> ?)
         + length(?) + length(?) <= ${MAX_VAULT_STORAGE_CHARS}
       )
     ON CONFLICT(user_id, id) DO UPDATE SET
       item_key_wrapped = excluded.item_key_wrapped,
       payload = excluded.payload,
       kind = excluded.kind,
       vk_version = excluded.vk_version,
       updated_at = ${NOW_SQL}`,
  )
    .bind(
      user.id,
      id,
      body.item_key_wrapped,
      body.payload,
      body.kind,
      body.vk_version,
      user.id,
      body.vk_version,
      user.id,
      id,
      user.id,
      user.id,
      id,
      body.payload,
      body.item_key_wrapped,
    )
    .run();
  if (!result.success) return c.json({ error: 'Failed to save vault item' }, 500);
  if (result.meta.changes === 0) {
    const envelope = await readEnvelope(c, user.id);
    if (!envelope) return c.json({ error: 'Vault not enabled' }, 404);
    if (envelope.vk_version === body.vk_version) {
      const limits = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(length(item_key_wrapped) + length(payload)), 0) AS chars
         FROM vault_items WHERE user_id = ? AND id <> ?`,
      )
        .bind(user.id, id)
        .first<{ total: number; chars: number }>();
      const existing = await c.env.DB.prepare('SELECT id FROM vault_items WHERE user_id = ? AND id = ?')
        .bind(user.id, id)
        .first();
      if (
        (!existing && (limits?.total ?? 0) >= MAX_VAULT_ITEMS) ||
        (limits?.chars ?? 0) + body.payload.length + body.item_key_wrapped.length > MAX_VAULT_STORAGE_CHARS
      ) {
        return c.json({ error: 'Vault item storage limit reached' }, 409);
      }
    }
    return c.json({ error: 'Vault key version conflict' }, 409);
  }
  return c.json({ id, kind: body.kind, vk_version: body.vk_version });
});

// DELETE /vault/items/:id — remove one encrypted personal item.
vault.delete('/vault/items/:id', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id') ?? '';
  if (!isValidVaultItemId(id)) return c.json({ error: 'Invalid vault item id' }, 400);
  const version = Number(c.req.query('vk_version'));
  if (!Number.isInteger(version) || version < 1) return c.json({ error: 'Invalid vault key version' }, 400);
  const removed = await c.env.DB.prepare(
    `DELETE FROM vault_items WHERE user_id = ? AND id = ? AND vk_version = ?
     AND EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ?)`,
  )
    .bind(user.id, id, version, user.id, version)
    .run();
  if (!removed.success) return c.json({ error: 'Failed to delete vault item' }, 500);
  if (removed.meta.changes === 0) {
    const envelope = await readEnvelope(c, user.id);
    if (!envelope) return c.json({ error: 'Vault not enabled' }, 404);
    if (envelope.vk_version !== version) return c.json({ error: 'Vault key version conflict' }, 409);
    return c.json({ error: 'Vault item not found' }, 404);
  }
  return c.json({ ok: true });
});

// DELETE /vault/items?kind=…&vk_version=… — bounded bulk deletion for a
// user's own encrypted collection, used by the draft manager.
vault.delete('/vault/items', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const kind = c.req.query('kind');
  const version = Number(c.req.query('vk_version'));
  if (!kind || !VAULT_ITEM_KINDS.has(kind)) return c.json({ error: 'Invalid vault item kind' }, 400);
  if (!Number.isInteger(version) || version < 1) return c.json({ error: 'Invalid vault key version' }, 400);
  const removed = await c.env.DB.prepare(
    `DELETE FROM vault_items WHERE user_id = ? AND kind = ? AND vk_version = ?
     AND EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ?)`,
  )
    .bind(user.id, kind, version, user.id, version)
    .run();
  if (!removed.success) return c.json({ error: 'Failed to delete vault items' }, 500);
  if (removed.meta.changes === 0) {
    const envelope = await readEnvelope(c, user.id);
    if (!envelope) return c.json({ error: 'Vault not enabled' }, 404);
    if (envelope.vk_version !== version) return c.json({ error: 'Vault key version conflict' }, 409);
  }
  return c.json({ ok: true, deleted: removed.meta.changes });
});

// POST /vault/keys/revoke-device — rotate VK and remove the revoked device.
// The client sends the new envelope and every item key re-wrapped under the new
// VK; the server only swaps opaque blobs and deletes the revoked row atomically.
vault.post('/vault/keys/revoke-device', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as EnvelopeBody & {
    current_srp?: SrpProofBody;
    vk_version?: unknown;
    device_id?: unknown;
    current_device_id?: unknown;
    item_keys?: unknown;
  };
  const envelopeError = validateEnvelope(body);
  if (envelopeError) return c.json({ error: envelopeError }, 400);
  if (!Number.isInteger(body.vk_version)) return c.json({ error: 'Invalid vault key version' }, 400);
  if (!hasProofShape(body.current_srp)) {
    return c.json({ error: 'Current password proof is required' }, 400);
  }
  if (!PAIRING_ID_PATTERN.test(String(body.device_id ?? ''))) {
    return c.json({ error: 'Invalid device registration' }, 400);
  }
  if (!PAIRING_ID_PATTERN.test(String(body.current_device_id ?? ''))) {
    return c.json({ error: 'Invalid current device id' }, 400);
  }
  if (body.device_id === body.current_device_id) return c.json({ error: 'Cannot revoke the current device' }, 400);
  if (!Array.isArray(body.item_keys) || body.item_keys.length > MAX_VAULT_ITEMS) {
    return c.json({ error: 'Invalid vault item keys' }, 400);
  }
  const itemKeys = body.item_keys as Array<{
    item_id?: unknown;
    item_key_wrapped?: unknown;
    item_key_wrapped_before?: unknown;
  }>;
  if (
    itemKeys.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        Array.isArray(item) ||
        !isValidVaultItemId(item.item_id) ||
        !isValidWrappedKey(item.item_key_wrapped) ||
        !isValidWrappedKey(item.item_key_wrapped_before),
    )
  ) {
    return c.json({ error: 'Invalid vault item keys' }, 400);
  }
  const submittedItemIds = itemKeys.map((item) => item.item_id as string);
  if (new Set(submittedItemIds).size !== submittedItemIds.length) {
    return c.json({ error: 'Invalid vault item keys' }, 400);
  }

  const current = await readEnvelope(c, user.id);
  if (!current) return c.json({ error: 'Vault not enabled' }, 404);
  const inventory = await c.env.DB.prepare('SELECT id FROM vault_items WHERE user_id = ?')
    .bind(user.id)
    .all<{ id: string }>();
  const existingItemIds = (inventory.results ?? []).map((item) => item.id);
  if (
    existingItemIds.length !== submittedItemIds.length ||
    existingItemIds.some((itemId) => !submittedItemIds.includes(itemId))
  ) {
    return c.json({ error: 'Vault item key inventory is incomplete' }, 409);
  }
  if (!(await verifyProof(c.env, user.id, body.current_srp))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const version = body.vk_version as number;
  const itemInventorySnapshot = JSON.stringify(
    itemKeys.map((item) => ({ item_id: item.item_id, item_key_wrapped_before: item.item_key_wrapped_before })),
  );
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE vault_keys
       SET salt = ?, recovery_salt = ?, kdf_params = ?, wrapped_vk = ?, recovery_blob = ?,
           vk_version = vk_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ? AND vk_version = ?
         AND EXISTS (SELECT 1 FROM device_keys WHERE user_id = ? AND id = ?)
         AND (SELECT COUNT(*) FROM vault_items WHERE user_id = ?) = ?
         AND NOT EXISTS (
           SELECT 1 FROM vault_items AS current_item
           WHERE current_item.user_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) AS requested_item
               WHERE json_extract(requested_item.value, '$.item_id') = current_item.id
                 AND json_extract(requested_item.value, '$.item_key_wrapped_before') = current_item.item_key_wrapped
                 AND current_item.vk_version = ?
             )
         )`,
    ).bind(
      body.salt as string,
      body.recovery_salt as string,
      JSON.stringify(body.kdf_params),
      body.wrapped_vk as string,
      (body.recovery_blob ?? current.recovery_blob) as string,
      user.id,
      version,
      user.id,
      String(body.device_id),
      user.id,
      itemKeys.length,
      user.id,
      itemInventorySnapshot,
      version,
    ),
  ];
  for (const item of itemKeys)
    statements.push(
      c.env.DB.prepare(
        `UPDATE vault_items SET item_key_wrapped = ?, vk_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_id = ? AND id = ? AND item_key_wrapped = ? AND vk_version = ?
           AND EXISTS (
             SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ? AND wrapped_vk = ?
           )`,
      ).bind(
        item.item_key_wrapped as string,
        version + 1,
        user.id,
        item.item_id as string,
        item.item_key_wrapped_before as string,
        version,
        user.id,
        version + 1,
        body.wrapped_vk as string,
      ),
    );
  statements.push(
    c.env.DB.prepare(
      `DELETE FROM device_keys
       WHERE user_id = ? AND id <> ?
         AND EXISTS (
           SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ? AND wrapped_vk = ?
         )
         AND EXISTS (SELECT 1 FROM device_keys WHERE user_id = ? AND id = ?)`,
    ).bind(
      user.id,
      String(body.current_device_id),
      user.id,
      version + 1,
      body.wrapped_vk as string,
      user.id,
      String(body.device_id),
    ),
  );

  const results = await c.env.DB.batch(statements);
  if (results.some((result) => !result.success)) return c.json({ error: 'Failed to revoke device' }, 500);
  if ((results[0].meta?.changes ?? 0) === 0) {
    const latest = await readEnvelope(c, user.id);
    if (!latest) return c.json({ error: 'Vault not enabled' }, 404);
    if (latest.vk_version !== version) return c.json({ error: 'Vault key version conflict' }, 409);
    const target = await c.env.DB.prepare('SELECT id FROM device_keys WHERE user_id = ? AND id = ?')
      .bind(user.id, String(body.device_id))
      .first();
    if (!target) return c.json({ error: 'Pairing not found' }, 404);
    return c.json({ error: 'Vault item key inventory changed' }, 409);
  }
  if ((results[results.length - 1].meta?.changes ?? 0) === 0) return c.json({ error: 'Pairing not found' }, 404);
  return c.json({ enabled: true, vk_version: version + 1 });
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
