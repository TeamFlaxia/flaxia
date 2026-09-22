// The in-memory vault session (docs/e2ee.md).
//
// VK exists unwrapped ONLY here, for as long as this module says it does:
// never in localStorage, never in a cookie, never in an IDB value, never in a
// response body. At rest it is always wrapped — by the password, by the
// recovery phrase, or by this device's non-extractable key. Every feature that
// needs VK (items, pairing approval, password re-wrap) asks this module, so
// there is exactly one place that decides when the key is alive.
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createSrpProof } from '../auth-srp.js';
import { fetchVaultKeys } from './client.js';
import {
  createDevice,
  detectDeviceLabel,
  getCurrentDeviceId,
  getOrCreateCurrentDevice,
  newDeviceId,
  saveVaultKeyForDevice,
  unlockWithDevice,
  unwrapImportedVaultKey,
} from './device.js';
import { createVaultEnvelope, unlockVaultWithPassword } from './primitives.ts';

export type VaultStatus = 'loading' | 'disabled' | 'locked' | 'unlocked';

export type EnableResult =
  | { ok: true }
  | { ok: false; error: 'proof_failed' | 'already_exists' | 'network' | 'failed' };

let sessionVk: Uint8Array | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to lock/unlock transitions; returns the unsubscribe function. */
export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The unwrapped vault key, or null while locked. Never persisted anywhere. */
export function getVaultKey(): Uint8Array | null {
  return sessionVk;
}

export function isVaultUnlocked(): boolean {
  return sessionVk !== null;
}

export function setVaultKey(vk: Uint8Array | null): void {
  sessionVk = vk;
  notify();
}

/** Drop VK from memory only — the device's wrapped copy survives a reload. */
export function lockVault(): void {
  sessionVk = null;
  notify();
}

/** 24 BIP39 words = 256 bits of entropy, well beyond any password. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

/**
 * Remember VK on this device so a reload reopens the vault without a prompt.
 * `deviceId` pins the local record's id — used when the id must match a row
 * the server already knows (enable = self-registration, pairing = QR id).
 * Failures are swallowed: blocked storage costs auto-unlock, not the session.
 */
async function rememberOnThisDevice(vk: Uint8Array, deviceId?: string): Promise<void> {
  try {
    const device = deviceId ? await createDevice(detectDeviceLabel(), deviceId) : await getOrCreateCurrentDevice();
    await saveVaultKeyForDevice(device, vk);
  } catch {
    // Private mode or a blocked storage API: this tab still holds VK, it just
    // has to ask for the password again after a reload.
  }
}

/**
 * Create the vault: derive the envelope locally, prove the password once with
 * SRP so the server will accept it, and register THIS device in the same
 * request under a client-chosen id. The id is chosen here so the local record
 * and the server's device_keys row are the same record — Settings can then
 * mark which line of the device list is this screen, and a stolen copy of
 * this device leaves behind a row someone else can revoke.
 */
export async function enableVault(password: string, recoveryPhrase: string): Promise<EnableResult> {
  const proof = await createSrpProof(password);
  if (!proof) return { ok: false, error: 'proof_failed' };

  const { envelope, vk } = await createVaultEnvelope(password, recoveryPhrase);
  const deviceId = newDeviceId();

  let res: Response;
  try {
    res = await fetch('/api/vault/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        current_srp: proof,
        ...envelope,
        device_id: deviceId,
        device_label: detectDeviceLabel(),
      }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.status === 409) return { ok: false, error: 'already_exists' };
  if (!res.ok) return { ok: false, error: 'failed' };

  await rememberOnThisDevice(vk, deviceId);
  setVaultKey(vk);
  return { ok: true };
}

/**
 * Unlock with the account password. The wrong password fails as a GCM unwrap,
 * which is indistinguishable from garbage ciphertext by design — hence
 * 'wrong' rather than an error message that could oracle the envelope.
 */
export async function unlockVault(password: string): Promise<'ok' | 'wrong' | 'error'> {
  const keys = await fetchVaultKeys();
  if (keys === null) return 'error';
  if (!keys.enabled || !keys.salt || !keys.kdf_params || !keys.wrapped_vk) return 'error';

  try {
    const vk = await unlockVaultWithPassword(password, {
      salt: keys.salt,
      kdf_params: keys.kdf_params,
      wrapped_vk: keys.wrapped_vk,
    });
    await rememberOnThisDevice(vk);
    setVaultKey(vk);
    return 'ok';
  } catch {
    return 'wrong';
  }
}

/** Auto-unlock on page load via this device's non-extractable key. */
export async function tryDeviceUnlock(): Promise<boolean> {
  if (!getCurrentDeviceId()) return false;
  try {
    const vk = await unlockWithDevice();
    if (!vk) return false;
    setVaultKey(vk);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finish a QR pairing: open the handoff blob with our ephemeral secret, adopt
 * the pairing's id as this device's id, and keep VK wrapped under the new
 * device key. The ephemeral private half was already zeroed by the caller —
 * after this, nothing on earth can reopen that blob again, including us.
 */
export async function adoptPairedVaultKey(wrappedVk: string, pairingId: string): Promise<boolean> {
  try {
    const device = await createDevice(detectDeviceLabel(), pairingId);
    const vk = await unwrapImportedVaultKey(wrappedVk, device);
    await saveVaultKeyForDevice(device, vk);
    setVaultKey(vk);
    return true;
  } catch {
    return false;
  }
}
