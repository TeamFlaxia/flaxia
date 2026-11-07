// Typed fetch wrapper for /api/mail/* (docs/mail.md §8).
//
// Every mutation carries an Idempotency-Key (crypto.randomUUID). Quota and
// error codes surface as thrown Errors carrying the stable code from the
// server (mail_vault_required, mail_rate_limited, mail_quota_exceeded, ...).

export type MailSecurity = 'e2ee' | 'at_rest' | 'tls';

export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash';

export interface MailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface MailThreadSummary {
  id: string;
  folder: MailFolder;
  subject: string;
  snippet: string;
  from_name: string;
  from_address: string;
  date: string;
  unread: boolean;
  starred: boolean;
  has_attachment: boolean;
  message_count: number;
  security: MailSecurity;
}

export interface MailMessage {
  id: string;
  from_name: string;
  from_address: string;
  to: string[];
  date: string;
  body_text: string;
  body_html?: string;
  quoted_text?: string;
  security: MailSecurity;
  attachments?: MailAttachment[];
}

export interface MailThreadDetail {
  id: string;
  subject: string;
  security: MailSecurity;
  labels?: string[];
  messages: MailMessage[];
}

export interface MailThreadList {
  threads: MailThreadSummary[];
  next_cursor?: string;
  counts?: Partial<Record<MailFolder, number>>;
}

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

export function isMailNotImplemented(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: number }).status;
  return status === 501 || error.message === 'mail_not_implemented';
}

export function listThreads(params: {
  folder: MailFolder;
  cursor?: string;
  limit?: number;
  q?: string;
}): Promise<MailThreadList> {
  const search = new URLSearchParams({ folder: params.folder, limit: String(params.limit ?? 30) });
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.q) search.set('q', params.q);
  return request(`/api/mail/threads?${search.toString()}`);
}

export function getThread(id: string): Promise<MailThreadDetail> {
  return request(`/api/mail/threads/${encodeURIComponent(id)}`);
}

export function applyMessageAction(action: string, ids: string[]): Promise<unknown> {
  return request('/api/mail/messages/actions', {
    method: 'POST',
    body: JSON.stringify({ action, ids }),
  });
}

export function sendMessage(input: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  security: MailSecurity;
}): Promise<unknown> {
  return request('/api/mail/messages', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveDraft(input: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
}): Promise<unknown> {
  return request('/api/mail/drafts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
