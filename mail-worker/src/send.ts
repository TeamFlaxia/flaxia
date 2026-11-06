/// <reference types="@cloudflare/workers-types" />
// Outbound pipeline (docs/mail.md §9.2). P1 skeleton — full MIME builder in P3.
// Header injection guard is already enforced: CR/LF in addresses/subject = reject.
import type { MailEnv } from './ingest.ts';

export const MAX_OUTBOUND_BYTES = 10 * 1024 * 1024;
export const MAX_RECIPIENTS = 20;
export const MAX_ATTACHMENTS = 20;
export const DEFAULT_DAILY_EXTERNAL_SENDS = 20;
export const DEFAULT_STORAGE_QUOTA_BYTES = 512 * 1024 * 1024;

export function assertNoHeaderInjection(value: string, field: string): void {
  if (value.includes('\r') || value.includes('\n')) throw new Error(`mail_header_injection:${field}`);
}

export function validateOutboundRecipients(recipients: string[]): string[] {
  if (recipients.length === 0) throw new Error('mail_no_recipients');
  if (recipients.length > MAX_RECIPIENTS) throw new Error('mail_too_many_recipients');
  for (const r of recipients) assertNoHeaderInjection(r, 'to');
  return recipients.map((r) => r.trim().toLowerCase());
}

export function validateOutboundSize(bytes: number): void {
  if (bytes > MAX_OUTBOUND_BYTES) throw new Error('mail_too_large');
}

// Full external send (SMTP via MAIL_SEND) is P3; this stub reserves the job row.
export async function queueOutboundJob(env: MailEnv, userId: string, messageId: string): Promise<void> {
  await env.MAIL_DB.prepare(
    `INSERT INTO mail_outbound_jobs (id, message_id, user_id, state) VALUES (?, ?, ?, 'pending')`,
  )
    .bind(crypto.randomUUID(), messageId, userId)
    .run();
}
