// Personal vault key storage (docs/e2ee.md).
//
// The server stores wrapped key material and nothing else: no password, no
// KEK/REK/VK, no recovery phrase. Handlers shape-check the opaque strings so a
// malformed value is rejected early, but they can never interpret one — the
// allowlists below are the entire server-side "understanding" of this data.
import { Hono } from 'hono';
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
): Promise<Array<{ id: string; label: string; created_at: string }>> {
  const result = await c.env.DB.prepare(
    'SELECT id, label, created_at FROM device_keys WHERE user_id = ? ORDER BY created_at',
  )
    .bind(userId)
    .all<{ id: string; label: string; created_at: string }>();
  return result.results ?? [];
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

export default vault;
