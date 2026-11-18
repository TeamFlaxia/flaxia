// Browser client for Flaxia Auth's third-party connections.
//
// The account, the connection metadata and the Personal Vault live on
// auth.flaxia.app. The settings page calls it directly: both origins share the
// flaxia.app site, so the SameSite=Lax session cookie is sent, and Auth allows
// the Flaxia origin for credentialed CORS. Tokens never travel in this
// module's responses; only the sealed envelope does.

export const AUTH_ORIGIN = 'https://auth.flaxia.app';

/**
 * Pick the workspace bound to an org-scoped device grant. When the Console
 * binds the grant to a workspace it returns `org_id` with the token; that org
 * is authoritative. Returns null when the caller still needs to prompt.
 */
export function selectGrantedOrg(orgs: OpenCodeOrg[], grantedOrgId: string | null | undefined): OpenCodeOrg | null {
  if (typeof grantedOrgId === 'string' && grantedOrgId.length > 0) {
    return orgs.find((org) => org.id === grantedOrgId) ?? null;
  }
  return orgs.length === 1 ? (orgs[0] ?? null) : null;
}

export class AuthConnectionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthConnectionError';
    this.status = status;
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown };
    if (typeof body.error_description === 'string') return body.error_description;
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON.
  }
  return `Request failed (${response.status})`;
};

async function authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${AUTH_ORIGIN}${path}`, {
    ...init,
    credentials: 'include',
    mode: 'cors',
    headers,
  });
  if (!response.ok) throw new AuthConnectionError(response.status, await errorMessage(response));
  return (await response.json()) as T;
}

export interface AuthConnection {
  id: string;
  provider: string;
  provider_sub: string | null;
  scopes: string[];
  status: 'active' | 'revoked';
  vault_item_id: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAuthConnections(): Promise<AuthConnection[]> {
  const body = await authJson<{ connections: AuthConnection[] }>('/api/connections');
  return body.connections;
}

export async function deleteAuthConnection(provider: string): Promise<void> {
  await authJson<{ success: true }>(`/api/connections/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
}

export interface DeviceAuthorization {
  transaction_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  expires_in: number;
  interval: number;
}

export interface OpenCodeOrg {
  id: string;
  name: string;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'complete'; sealed: SealedEnvelope; orgs: OpenCodeOrg[] };

export async function startOpenCodeDevice(state: string): Promise<DeviceAuthorization> {
  return authJson<DeviceAuthorization>('/api/connections/opencode/device/start', {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
}

export async function pollOpenCodeDevice(input: {
  transaction_id: string;
  state: string;
  device_code: string;
  client_public_key: string;
  interval?: number;
}): Promise<DevicePollResult> {
  return authJson<DevicePollResult>('/api/connections/opencode/device/poll', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function completeOpenCodeConnection(input: {
  transaction_id: string;
  state: string;
  vault_item_id: string;
  scopes: string[];
  expires_at?: string | null;
  refresh_expires_at?: string | null;
}): Promise<void> {
  await authJson<{ success: true }>('/api/connections/opencode/complete', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ─── Seal ───────────────────────────────────────────────────────────────────
// Auth seals the device token response to an ephemeral ECDH key held here
// (flaxia-auth/src/oauth/seal.ts). The private half never leaves the page.

export interface SealedEnvelope {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
}

const CURVE = 'ECDH';
const NAMED_CURVE = 'P-256';
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const HKDF_INFO = 'flaxia.oauth.seal.v1';

const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const isBase64 = (value: unknown, expectedLength?: number): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  let bytes: Uint8Array;
  try {
    bytes = decode(value);
  } catch {
    return false;
  }
  return expectedLength === undefined ? bytes.length > 0 : bytes.length === expectedLength;
};

async function deriveKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', sharedSecret as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, KEY_LENGTH);
  return new Uint8Array(bits);
}

export async function createSealKeyPair(): Promise<{ pair: CryptoKeyPair; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: CURVE, namedCurve: NAMED_CURVE }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { pair, publicKey: encode(new Uint8Array(exported as ArrayBuffer)) };
}

export async function openSealed(envelope: SealedEnvelope, privateKey: CryptoKey): Promise<Uint8Array> {
  if (!envelope || typeof envelope !== 'object') throw new Error('Invalid sealed envelope');
  const { ephemeralPublicKey, iv, ciphertext } = envelope;
  if (!isBase64(ephemeralPublicKey) || !isBase64(iv, IV_LENGTH) || !isBase64(ciphertext)) {
    throw new Error('Invalid sealed envelope');
  }
  let ephemeralKey: CryptoKey;
  try {
    ephemeralKey = await crypto.subtle.importKey(
      'spki',
      decode(ephemeralPublicKey) as BufferSource,
      { name: CURVE, namedCurve: NAMED_CURVE },
      false,
      [],
    );
  } catch {
    throw new Error('Invalid sealed envelope');
  }
  const key = await deriveKey(await sharedSecret(privateKey, ephemeralKey));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv) as BufferSource },
    key,
    decode(ciphertext) as BufferSource,
  );
  return new Uint8Array(plaintext);
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
