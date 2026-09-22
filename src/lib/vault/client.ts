// Vault unlock/rewrap plumbing used by the UI (docs/e2ee.md).
//
// This module is the only place that fetches the wrapped envelope and turns it
// back into a key. The VK it produces stays in memory for the length of a call
// and is never written to storage.
import {
  DEFAULT_VAULT_KDF_PARAMS,
  encodeB64,
  generateVaultSalt,
  rewrapVaultKeyForPassword,
  unlockVaultWithPassword,
  type VaultKdfParams,
} from './primitives.ts';

export interface VaultKeysResponse {
  enabled: boolean;
  salt?: string;
  recovery_salt?: string;
  kdf_params?: VaultKdfParams;
  wrapped_vk?: string;
  recovery_blob?: string;
  vk_version?: number;
  devices?: Array<{ id: string; label: string; created_at: string }>;
}

export interface VaultRewrapFields {
  salt: string;
  kdf_params: VaultKdfParams;
  wrapped_vk: string;
}

export type VaultRewrap =
  /** The account has no vault — nothing to carry over. */
  | { status: 'none' }
  | { status: 'ok'; fields: VaultRewrapFields }
  /** The current password does not open the vault: refuse to change anything. */
  | { status: 'unlock_failed' }
  /** The envelope could not be read (network/server) — refuse rather than risk orphaning it. */
  | { status: 'error' };

export async function fetchVaultKeys(): Promise<VaultKeysResponse | null> {
  try {
    const res = await fetch('/api/vault/keys', { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as VaultKeysResponse;
  } catch {
    return null;
  }
}

/**
 * While the user still holds the CURRENT password, unwrap VK and re-wrap it
 * under the NEW one. The result is sent inside `PATCH /users/me/password` so
 * the verifier and the vault envelope are swapped in a single atomic step —
 * a vault whose wrapped_vk still expects the old password is unreachable.
 */
export async function prepareVaultRewrap(currentPassword: string, newPassword: string): Promise<VaultRewrap> {
  const keys = await fetchVaultKeys();
  if (keys === null) return { status: 'error' };
  if (!keys.enabled) return { status: 'none' };
  if (!keys.salt || !keys.kdf_params || !keys.wrapped_vk) return { status: 'error' };

  let vk: Uint8Array;
  try {
    vk = await unlockVaultWithPassword(currentPassword, {
      salt: keys.salt,
      kdf_params: keys.kdf_params,
      wrapped_vk: keys.wrapped_vk,
    });
  } catch {
    return { status: 'unlock_failed' };
  }

  // Fresh salt with the new password: even a reused password ends up with a
  // KEK the old envelope cannot open.
  const salt = generateVaultSalt();
  const wrapped_vk = await rewrapVaultKeyForPassword(vk, newPassword, salt, keys.kdf_params);
  return {
    status: 'ok',
    fields: { salt: encodeB64(salt), kdf_params: keys.kdf_params, wrapped_vk },
  };
}

/** Enable-vault payload helper: build the envelope body from a password + phrase. */
export { DEFAULT_VAULT_KDF_PARAMS };

// ─── Device pairing (/vault/devices) ────────────────────────────────────────
// The server relays public keys and one opaque handoff blob; the X25519 shared
// secret and VK itself never cross it (docs/e2ee.md, "Pairing a second device").

export interface DeviceSummary {
  id: string;
  label: string;
  state: 'pending' | 'active';
  created_at: string;
}

export interface PairingPoll {
  id: string;
  state: 'pending' | 'active' | 'expired';
  label?: string;
  expires_at?: string;
  /** Present only for an approved pairing, and only openable by the joiner. */
  approved_pub?: string;
  wrapped_vk?: string;
}

export type ApproveResult = 'ok' | 'reused' | 'expired' | 'failed';

export async function listDevices(): Promise<DeviceSummary[]> {
  try {
    const res = await fetch('/api/vault/devices', { credentials: 'include' });
    if (!res.ok) return [];
    const data = (await res.json()) as { devices?: DeviceSummary[] };
    return data.devices ?? [];
  } catch {
    return [];
  }
}

/** Begin a pairing: publish this device's ephemeral public half, get an id for the QR. */
export async function startPairing(
  label: string,
  peerPub: string,
  ttlSeconds?: number,
): Promise<{ id: string; expires_at: string | null } | null> {
  try {
    const res = await fetch('/api/vault/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ label, peer_pub: peerPub, ttl_seconds: ttlSeconds }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string; expires_at: string | null };
  } catch {
    return null;
  }
}

export async function pollPairing(id: string): Promise<PairingPoll | null> {
  try {
    const res = await fetch(`/api/vault/devices/${encodeURIComponent(id)}`, { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as PairingPoll;
  } catch {
    return null;
  }
}

export async function approvePairing(id: string, approvedPub: string, wrappedVk: string): Promise<ApproveResult> {
  try {
    const res = await fetch(`/api/vault/devices/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ approved_pub: approvedPub, wrapped_vk: wrappedVk }),
    });
    if (res.ok) return 'ok';
    if (res.status === 409) return 'reused';
    if (res.status === 410) return 'expired';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** Abandon our own QR before it expires (the TTL reap is the backstop). */
export async function cancelPairing(id: string): Promise<void> {
  try {
    await fetch(`/api/vault/devices/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  } catch {
    // An abandoned row dies with its expiry anyway.
  }
}

export async function revokeDevice(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/vault/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}
