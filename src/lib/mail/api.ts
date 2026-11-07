// Typed fetch wrapper for /api/mail/* (docs/mail.md §8).
//
// Every mutation carries an Idempotency-Key (crypto.randomUUID). Quota and
// error codes surface as thrown Errors carrying the stable code from the
// server (mail_vault_required, mail_rate_limited, mail_quota_exceeded, ...).

export type MailSecurity = 'e2ee' | 'at_rest' | 'tls';

export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash';

export interface MailAttachment {
  /** Server attachment row id (download route). */
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Logical attachment id bound into the AEAD AAD / HKDF info. */
  aad_id?: string;
  iv?: string;
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

export interface WrappedMailKey {
  ephemeral_public_key: string;
  iv: string;
  wrapped_content_key: string;
  key_version: number;
  recipient_address: string;
}

export interface EncryptedThreadRow {
  id: string;
  folder: MailFolder;
  last_message_at: string;
  message_count: number;
  unread_count: number;
  message_id: string;
  subject_enc: string;
  meta_enc: string;
  payload_iv: string;
  blob_id: string;
  aad_id: string;
  from_addr: string;
  received_at: string;
  read_at: string | null;
  starred_at: string | null;
  has_attachments: boolean;
  size_bytes: number;
  security: MailSecurity;
  key: WrappedMailKey | null;
}

export interface EncryptedThreadList {
  threads: EncryptedThreadRow[];
  next_cursor?: string;
  counts?: Partial<Record<MailFolder, number>>;
}

export interface EncryptedMessageRow {
  id: string;
  from_addr: string;
  to_addr: string;
  from_name_enc: string;
  subject_enc: string;
  meta_enc: string;
  payload_iv: string;
  blob_id: string;
  aad_id: string;
  message_id_hash: string;
  in_reply_to_hash: string;
  references_hash: string;
  sent_at: string | null;
  received_at: string;
  size_bytes: number;
  has_attachments: boolean;
  read_at: string | null;
  starred_at: string | null;
  security: MailSecurity;
  auth_results: string;
  spam_score: number;
  key: WrappedMailKey | null;
}

export interface EncryptedAttachmentRow {
  id: string;
  message_id: string;
  aad_id: string;
  iv: string;
  content_type: string;
  size_bytes: number;
  scan_status: string;
}

export interface EncryptedThreadResponse {
  thread: {
    id: string;
    folder: MailFolder;
    subject_enc: string;
    last_message_at: string;
    message_count: number;
    unread_count: number;
  };
  messages: EncryptedMessageRow[];
  attachments: EncryptedAttachmentRow[];
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
}): Promise<EncryptedThreadList> {
  const search = new URLSearchParams({ folder: params.folder, limit: String(params.limit ?? 30) });
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.q) search.set('q', params.q);
  return request(`/api/mail/threads?${search.toString()}`);
}

export function getThread(id: string): Promise<EncryptedThreadResponse> {
  return request(`/api/mail/threads/${encodeURIComponent(id)}`);
}

async function binaryRequest(path: string): Promise<Uint8Array> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error ?? `mail_request_failed:${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function fetchMailPayload(messageId: string): Promise<Uint8Array> {
  return binaryRequest(`/api/mail/messages/${encodeURIComponent(messageId)}/payload`);
}

export function fetchMailAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
  return binaryRequest(
    `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export function applyMessageAction(action: string, ids: string[]): Promise<unknown> {
  return request('/api/mail/messages/actions', {
    method: 'POST',
    body: JSON.stringify({ action, ids }),
  });
}

export interface SendAttachmentInput {
  /** Logical attachment id (also the HKDF info input). */
  id: string;
  iv: string;
  ciphertext: string;
  filename_enc: string;
  content_type: string;
  size_bytes: number;
}

export interface SendKeyInput {
  address: string;
  key_version: number;
  ephemeral_public_key: string;
  iv: string;
  wrapped_content_key: string;
}

/** Client-sealed envelope for POST /api/mail/messages and drafts (§9.2). */
export interface SendEnvelopeInput {
  message_id: string;
  thread_id?: string;
  in_reply_to_hash?: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject_enc: string;
  from_name_enc: string;
  meta_enc: string;
  payload: { iv: string; ciphertext: string };
  attachments?: SendAttachmentInput[];
  keys: SendKeyInput[];
}

export interface MailDraftRow {
  id: string;
  from_addr: string;
  to_addr: string;
  subject_enc: string;
  meta_enc: string;
  payload_iv: string;
  aad_id: string;
  received_at: string;
  size_bytes: number;
  has_attachments: boolean;
  key: WrappedMailKey | null;
}

export interface MailDraftDetail {
  draft: MailDraftRow;
  attachments: EncryptedAttachmentRow[];
}

export function sendMessage(
  envelope: SendEnvelopeInput,
): Promise<{ ok: boolean; message_id: string; delivered: number }> {
  return request('/api/mail/messages', { method: 'POST', body: JSON.stringify(envelope) });
}

export function saveDraft(envelope: SendEnvelopeInput): Promise<{ ok: boolean; draft_id: string }> {
  return request('/api/mail/drafts', { method: 'POST', body: JSON.stringify(envelope) });
}

export function updateDraft(draftId: string, envelope: SendEnvelopeInput): Promise<{ ok: boolean; draft_id: string }> {
  return request(`/api/mail/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PATCH',
    body: JSON.stringify(envelope),
  });
}

export function deleteDraft(draftId: string): Promise<unknown> {
  return request(`/api/mail/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
}

export function listDrafts(): Promise<{ drafts: MailDraftRow[] }> {
  return request('/api/mail/drafts');
}

export function getDraft(draftId: string): Promise<MailDraftDetail> {
  return request(`/api/mail/drafts/${encodeURIComponent(draftId)}`);
}

export function fetchDraftPayload(draftId: string): Promise<Uint8Array> {
  return binaryRequest(`/api/mail/drafts/${encodeURIComponent(draftId)}/payload`);
}

export function fetchDraftAttachment(draftId: string, attachmentId: string): Promise<Uint8Array> {
  return binaryRequest(
    `/api/mail/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}
