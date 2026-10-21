// Encrypted user data stored by the Personal Vault. This module is the only
// bridge from application records to /api/vault/items: callers pass plaintext
// values, and only ciphertext plus wrapped item keys cross the network.

import { decryptVaultItem, encodeB64, encryptVaultItem, type VaultItemCiphertext } from './primitives.ts';
import { getVaultKey, getVaultKeyVersion } from './session.ts';

export type VaultItemKind = 'post_autosave' | 'post_draft' | 'private_note' | 'personal_setting';

interface StoredVaultItem {
  id: string;
  item_key_wrapped: string;
  payload: string;
  kind: VaultItemKind;
  vk_version: number;
  created_at: string;
  updated_at: string;
}

interface StoredItemEnvelope<T> {
  format: 1;
  kind: VaultItemKind;
  value: T;
}

function currentKey(): { key: Uint8Array; version: number } {
  const key = getVaultKey();
  const version = getVaultKeyVersion();
  if (!key || !version) throw new Error('Unlock the Personal Vault to access encrypted items');
  return { key, version };
}

export function newVaultItemId(): string {
  return encodeB64(crypto.getRandomValues(new Uint8Array(16)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Fetch and decrypt one kind of item. A damaged item fails closed. */
export async function listVaultItems<T>(kind: VaultItemKind): Promise<Array<{ id: string; value: T }>> {
  const { key, version } = currentKey();
  const res = await fetch(`/api/vault/items?kind=${encodeURIComponent(kind)}`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load encrypted vault items');
  const data = (await res.json()) as { items?: StoredVaultItem[] };
  if (!Array.isArray(data.items)) throw new Error('Invalid encrypted vault item response');

  const result: Array<{ id: string; value: T }> = [];
  for (const item of data.items) {
    if (item.kind !== kind || item.vk_version !== version || typeof item.id !== 'string') {
      throw new Error('Vault item version or type mismatch');
    }
    const plaintext = await decryptVaultItem(key, item.id, item.item_key_wrapped, item.payload);
    try {
      const stored = JSON.parse(new TextDecoder().decode(plaintext)) as StoredItemEnvelope<T>;
      if (stored.format !== 1 || stored.kind !== kind || !('value' in stored)) {
        throw new Error('Vault item type mismatch');
      }
      result.push({ id: item.id, value: stored.value });
    } finally {
      plaintext.fill(0);
    }
  }
  return result;
}

/** Encrypt locally and create or replace an item on the server. */
export async function saveVaultItem<T>(id: string, kind: VaultItemKind, value: T): Promise<void> {
  const { key, version } = currentKey();
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ format: 1, kind, value } satisfies StoredItemEnvelope<T>),
  );
  let encrypted: VaultItemCiphertext;
  try {
    encrypted = await encryptVaultItem(key, id, plaintext);
  } finally {
    plaintext.fill(0);
  }

  const res = await fetch(`/api/vault/items/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      item_key_wrapped: encrypted.item_key_wrapped,
      payload: encrypted.payload,
      kind,
      vk_version: version,
    }),
  });
  if (res.status === 409) throw new Error('Vault key changed on another device; unlock the vault again');
  if (!res.ok) throw new Error('Failed to save encrypted vault item');
}

export async function deleteVaultItem(id: string): Promise<void> {
  const { version } = currentKey();
  const res = await fetch(`/api/vault/items/${encodeURIComponent(id)}?vk_version=${version}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (res.status === 409) throw new Error('Vault key changed on another device; unlock the vault again');
  if (!res.ok && res.status !== 404) throw new Error('Failed to delete encrypted vault item');
}

export async function deleteVaultItems(kind: VaultItemKind): Promise<void> {
  const { version } = currentKey();
  const params = new URLSearchParams({ kind, vk_version: String(version) });
  const res = await fetch(`/api/vault/items?${params}`, { method: 'DELETE', credentials: 'include' });
  if (res.status === 409) throw new Error('Vault key changed on another device; unlock the vault again');
  if (!res.ok) throw new Error('Failed to delete encrypted vault items');
}
