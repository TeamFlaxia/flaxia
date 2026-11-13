import { isValidB64, isValidVaultKdfParams, isValidWrappedKey } from '../../src/lib/vault/primitives.ts';
import { authIsAuthoritative, authVaultImport, authVaultRequest } from './flaxia-auth.ts';

type VaultEnv = { DB: D1Database; AUTH_SERVICE?: Fetcher; AUTH_AUTHORITY_MODE?: string };

export type AuthVaultState = { enabled: boolean; vk_version: number };

type LocalEnvelope = {
  salt: string;
  recovery_salt: string;
  kdf_params: unknown;
  wrapped_vk: string;
  recovery_blob: string;
  vk_version: number;
  created_at: string;
  updated_at: string;
};

type LocalVault = {
  keys: LocalEnvelope;
  devices: unknown[];
  items: unknown[];
};

/**
 * Read the transitional rows Flaxia wrote before Auth owned the Vault. Values
 * are opaque ciphertext; only the envelope shape is checked so a corrupted row
 * cannot be imported as if it were valid.
 */
async function readLocalVault(db: D1Database, userId: string): Promise<LocalVault | null> {
  const row = await db
    .prepare(
      `SELECT salt, recovery_salt, kdf_params, wrapped_vk, recovery_blob, vk_version, created_at, updated_at
       FROM vault_keys WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{
      salt: string;
      recovery_salt: string;
      kdf_params: string;
      wrapped_vk: string;
      recovery_blob: string;
      vk_version: number;
      created_at: string;
      updated_at: string;
    }>();
  if (!row || !Number.isSafeInteger(row.vk_version) || row.vk_version < 1) return null;
  let kdfParams: unknown;
  try {
    kdfParams = JSON.parse(row.kdf_params);
  } catch {
    return null;
  }
  if (
    !isValidB64(row.salt, 16) ||
    !isValidB64(row.recovery_salt, 16) ||
    !isValidVaultKdfParams(kdfParams) ||
    !isValidWrappedKey(row.wrapped_vk) ||
    !isValidWrappedKey(row.recovery_blob)
  ) {
    return null;
  }
  const devices = await db
    .prepare(
      `SELECT id, label, state, peer_pub, approved_pub, wrapped_vk, created_at, expires_at, last_seen_at
       FROM device_keys WHERE user_id = ?
         AND NOT (state = 'pending' AND expires_at <> '' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ORDER BY created_at`,
    )
    .bind(userId)
    .all();
  const items = await db
    .prepare(
      `SELECT id, item_key_wrapped, payload, kind, vk_version, created_at, updated_at
       FROM vault_items WHERE user_id = ? ORDER BY created_at`,
    )
    .bind(userId)
    .all();
  return {
    keys: { ...row, kdf_params: kdfParams },
    devices: devices.results ?? [],
    items: items.results ?? [],
  };
}

function envelopeMatches(envelope: Record<string, unknown>, local: LocalEnvelope): boolean {
  return (
    envelope.enabled === true &&
    envelope.salt === local.salt &&
    envelope.recovery_salt === local.recovery_salt &&
    envelope.wrapped_vk === local.wrapped_vk &&
    envelope.recovery_blob === local.recovery_blob &&
    envelope.vk_version === local.vk_version
  );
}

/**
 * Remove the transitional rows only after Auth has acknowledged the exact same
 * envelope, so a failed or concurrent import can never delete the only copy.
 * Deletion is best-effort: a leftover row is inert once Auth is authoritative.
 */
async function deleteLocalVault(db: D1Database, userId: string, keys: LocalEnvelope): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          `DELETE FROM vault_items WHERE user_id = ?
           AND EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND salt = ? AND recovery_salt = ?
             AND wrapped_vk = ? AND recovery_blob = ? AND vk_version = ?)`,
        )
        .bind(userId, userId, keys.salt, keys.recovery_salt, keys.wrapped_vk, keys.recovery_blob, keys.vk_version),
      db
        .prepare(
          `DELETE FROM device_keys WHERE user_id = ?
           AND EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND salt = ? AND recovery_salt = ?
             AND wrapped_vk = ? AND recovery_blob = ? AND vk_version = ?)`,
        )
        .bind(userId, userId, keys.salt, keys.recovery_salt, keys.wrapped_vk, keys.recovery_blob, keys.vk_version),
      db
        .prepare(
          `DELETE FROM vault_keys WHERE user_id = ? AND salt = ? AND recovery_salt = ?
             AND wrapped_vk = ? AND recovery_blob = ? AND vk_version = ?`,
        )
        .bind(userId, keys.salt, keys.recovery_salt, keys.wrapped_vk, keys.recovery_blob, keys.vk_version),
    ]);
  } catch {
    // A credential-change guard can hold the row briefly; the next vault
    // request retries the cleanup.
  }
}

/**
 * Make Auth the owner of this user's Vault, importing the transitional Flaxia
 * rows once if they still exist. Returns null when Auth is unavailable or the
 * stores disagree, so callers fail closed instead of using a stale envelope.
 */
export async function ensureAuthVault(env: VaultEnv, grant: string, userId: string): Promise<AuthVaultState | null> {
  if (!authIsAuthoritative(env)) return null;
  const current = await authVaultRequest(env, grant, userId, 'GET', '/api/vault/keys');
  if (!current || typeof current.body.enabled !== 'boolean') return null;
  if (current.body.enabled === true) {
    const version = current.body.vk_version;
    if (!Number.isSafeInteger(version) || (version as number) < 1) return null;
    const local = await readLocalVault(env.DB, userId);
    if (local && envelopeMatches(current.body, local.keys)) await deleteLocalVault(env.DB, userId, local.keys);
    return { enabled: true, vk_version: version as number };
  }

  const local = await readLocalVault(env.DB, userId);
  if (!local) return { enabled: false, vk_version: 0 };
  const imported = await authVaultImport(env, grant, userId, local);
  if (imported === 'unavailable' || imported === 'conflict') {
    console.error('Auth vault import failed', { userId, reason: imported });
    return null;
  }
  await deleteLocalVault(env.DB, userId, local.keys);

  // Re-read after import: another device may have advanced the envelope while
  // the copy was in flight, and callers need the version Auth will accept.
  const verified = await authVaultRequest(env, grant, userId, 'GET', '/api/vault/keys');
  if (!verified || verified.body.enabled !== true) return null;
  const version = verified.body.vk_version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return null;
  return { enabled: true, vk_version: version as number };
}
