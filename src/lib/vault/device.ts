// Per-device key storage (docs/e2ee.md).
//
// Each device keeps ONE non-extractable AES-GCM key in IndexedDB. Page script
// can ask it to wrap/unwrap VK but can never read the bytes back out, so a
// stolen database dump of IndexedDB yields a key that opens nothing without
// this origin's storage.
//
// VK itself is never persisted raw: it is stored wrapped under this device key,
// which is what makes "reload the page and the vault re-opens" work without a
// password prompt.
import { encodeB64, unwrapVaultKeyWithDevice, wrapVaultKeyForDevice } from './primitives.ts';

const DB_NAME = 'flaxia_vault';
const DB_VERSION = 1;
const STORE_DEVICES = 'devices';
const CURRENT_DEVICE_KEY = 'flaxia.current_device_id';

export interface StoredDevice {
  id: string;
  label: string;
  createdAt: string;
  /** Non-extractable — `extractable` is false by construction. */
  key: CryptoKey;
  /** VK wrapped under `key`; absent until the device has unlocked once. */
  wrappedVk?: string;
}

function unavailable(detail: string): Error {
  return new Error(`vault device storage unavailable: ${detail}`);
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw unavailable('IndexedDB is not present in this environment');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DEVICES)) db.createObjectStore(STORE_DEVICES, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(unavailable(request.error?.message ?? 'open failed'));
    request.onblocked = () => reject(unavailable('open blocked by another tab'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_DEVICES, mode);
      const request = run(tx.objectStore(STORE_DEVICES));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(unavailable(request.error?.message ?? 'request failed'));
      tx.onabort = () => reject(unavailable(tx.error?.message ?? 'transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Best-effort human name for the device list, e.g. "Chrome on Linux". */
export function detectDeviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const platform = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/i.test(ua)
        ? 'macOS'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'device';
  return `${browser} on ${platform}`;
}

function randomId(): string {
  return encodeB64(crypto.getRandomValues(new Uint8Array(16)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createDevice(label = detectDeviceLabel()): Promise<StoredDevice> {
  const raw = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  const device: StoredDevice = { id: randomId(), label, createdAt: new Date().toISOString(), key };
  await withStore<IDBValidKey>('readwrite', (store) => store.put(device));
  localStorage.setItem(CURRENT_DEVICE_KEY, device.id);
  return device;
}

export async function getDevice(id: string): Promise<StoredDevice | null> {
  const found = await withStore<StoredDevice | undefined>('readonly', (store) => store.get(id));
  return found ?? null;
}

export async function getOrCreateCurrentDevice(label?: string): Promise<StoredDevice> {
  const existingId = localStorage.getItem(CURRENT_DEVICE_KEY);
  if (existingId) {
    const existing = await getDevice(existingId);
    if (existing) return existing;
  }
  return createDevice(label);
}

/** Persist VK wrapped under this device's key — raw VK never touches storage. */
export async function saveVaultKeyForDevice(device: StoredDevice, vk: Uint8Array): Promise<StoredDevice> {
  const wrappedVk = await wrapVaultKeyForDevice(vk, device.key);
  const updated: StoredDevice = { ...device, wrappedVk };
  await withStore<IDBValidKey>('readwrite', (store) => store.put(updated));
  return updated;
}

/** Auto-unlock on reload. Returns null when this device has never unlocked. */
export async function unlockWithDevice(deviceId?: string): Promise<Uint8Array | null> {
  const id = deviceId ?? localStorage.getItem(CURRENT_DEVICE_KEY);
  if (!id) return null;
  const device = await getDevice(id);
  if (!device?.wrappedVk) return null;
  try {
    return await unwrapVaultKeyWithDevice(device.wrappedVk, device.key);
  } catch {
    // Storage was cleared or replaced while VK was away: the password path is
    // the only remaining way in, which is exactly the intended fallback.
    return null;
  }
}

export async function deleteDevice(id: string): Promise<void> {
  await withStore<undefined>('readwrite', (store) => store.delete(id));
  if (localStorage.getItem(CURRENT_DEVICE_KEY) === id) localStorage.removeItem(CURRENT_DEVICE_KEY);
}

/** Restore a wrapped VK captured from an API response (after QR pairing). */
export function unwrapImportedVaultKey(wrappedVk: string, device: StoredDevice): Promise<Uint8Array> {
  return unwrapVaultKeyWithDevice(wrappedVk, device.key);
}
