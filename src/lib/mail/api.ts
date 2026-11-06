// Typed fetch wrapper for /api/mail/* (docs/mail.md §8).
//
// Every mutation carries an Idempotency-Key (crypto.randomUUID). Quota and
// error codes surface as thrown Errors carrying the stable code from the
// server (mail_vault_required, mail_rate_limited, mail_quota_exceeded, ...).

export type MailSecurity = 'e2ee' | 'at_rest' | 'tls';

export interface MailQuota {
  storage_bytes: number;
  storage_quota_bytes: number;
  external_sends: number;
  daily_external_limit: number;
}

export interface MailAddressRow {
  address: string;
  kind: 'primary' | 'alias';
  state: 'active' | 'disabled';
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('Idempotency-Key', idempotencyKey());
  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) {
    const err = new Error((body as { error?: string }).error ?? `mail_request_failed:${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return body as T;
}

export function listAddresses(): Promise<{ addresses: MailAddressRow[] }> {
  return request('/api/mail/addresses');
}

export function activateAddress(input: {
  publicKey: string;
  keyVersion: number;
  vaultUnlocked: boolean;
}): Promise<unknown> {
  return request('/api/mail/addresses', {
    method: 'POST',
    body: JSON.stringify({
      public_key: input.publicKey,
      key_version: input.keyVersion,
      vault_unlocked: input.vaultUnlocked,
    }),
  });
}

export function getQuota(): Promise<MailQuota> {
  return request('/api/mail/quota');
}

export async function getMailUnreadCount(): Promise<number> {
  const result = await request<{ unread?: unknown }>('/api/mail/unread');
  return typeof result.unread === 'number' ? result.unread : 0;
}

export function getMyKey(): Promise<{ public_key: string; key_version: number; address: string }> {
  return request('/api/mail/keys/me');
}

export function publishKey(input: { publicKey: string; keyVersion: number }): Promise<unknown> {
  return request('/api/mail/keys/me', {
    method: 'PUT',
    body: JSON.stringify({ public_key: input.publicKey, key_version: input.keyVersion }),
  });
}

export function fetchKeysForAddresses(
  addresses: string[],
): Promise<{ keys: Array<{ address: string; public_key: string; key_version: number }> }> {
  return request(`/api/mail/keys?addresses=${encodeURIComponent(addresses.join(','))}`);
}
