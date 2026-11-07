/// <reference types="@cloudflare/workers-types" />
// Inbound MIME parsing (docs/mail.md §9.1). PostalMime is Workers-safe and
// returns decoded headers, text/html bodies and attachment bytes.
import PostalMime, { type Address, type Attachment as PostalAttachment } from 'postal-mime';
import { hmacHex, sha256Hex } from './crypto.ts';

export interface MailAuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
  raw: string;
  /** Two Authentication-Results headers disagree on a verdict. */
  ambiguous: boolean;
}

export interface ParsedAttachment {
  id: string;
  filename: string;
  contentType: string;
  content: Uint8Array;
  disposition: string | null;
  contentId: string | null;
  inline: boolean;
  blocked: boolean;
  sizeBytes: number;
}

export interface ParsedInbound {
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  text: string;
  html: string | null;
  snippet: string;
  attachments: ParsedAttachment[];
  auth: MailAuthResults;
  date: string | null;
  messageIdHeader: string;
  inReplyTo: string;
  referenceIds: string[];
  messageIdHash: string;
  inReplyToHash: string;
  referenceHashes: string[];
  subjectKey: string;
  spam: boolean;
  spamReason: string | null;
}

const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'scr',
  'bat',
  'cmd',
  'com',
  'js',
  'mjs',
  'cjs',
  'vbs',
  'ps1',
  'jar',
  'msi',
  'dll',
  'sh',
  'app',
  'deb',
  'rpm',
  'apk',
]);

const BLOCKED_MIME = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-sh',
  'application/x-shellscript',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]);

function mailbox(value: Address | undefined): { name: string; address: string } | null {
  if (!value) return null;
  if ('address' in value && value.address) return { name: value.name ?? '', address: value.address };
  if ('group' in value && Array.isArray(value.group) && value.group.length > 0) {
    const first = value.group[0];
    return { name: first.name ?? '', address: first.address ?? '' };
  }
  return null;
}

function addresses(values: Address[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    if ('address' in value && value.address) out.push(value.address.toLowerCase());
    else if ('group' in value && Array.isArray(value.group)) {
      for (const member of value.group) {
        if (member.address) out.push(member.address.toLowerCase());
      }
    }
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}

export function normalizeSubject(subject: string): string {
  let value = subject.trim();
  // Repeated reply/forward prefixes are noise for threading.
  for (let i = 0; i < 8; i += 1) {
    const next = value.replace(/^\s*(?:re|fwd?|aw|sv)\s*:\s*/i, '');
    if (next === value) break;
    value = next;
  }
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function headerValue(headers: Headers | undefined, name: string): string {
  return headers?.get(name) ?? '';
}

function parseAuthResults(raw: string): MailAuthResults {
  const result: MailAuthResults = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', raw, ambiguous: false };
  for (const match of raw.matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
    const key = match[1]?.toLowerCase();
    const value = match[2]?.toLowerCase();
    if (!key || !value) continue;
    if (key === 'spf') result.spf = value;
    else if (key === 'dkim') result.dkim = value;
    else result.dmarc = value;
  }
  return result;
}

function authHeaders(email: { key: string; value?: string }[], headers?: Headers): string[] {
  // Every ARH in the message must agree; a client-supplied one before our MX
  // is indistinguishable from a real verdict, so conflicts are quarantined
  // instead of trusting the first header. See docs/mail.md §9.1 step 4.
  const values = email
    .filter((header) => header.key === 'authentication-results')
    .map((header) => header.value ?? '')
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    const fallback = headerValue(headers, 'Authentication-Results');
    if (fallback) values.push(fallback);
  }
  return values;
}

function mergeAuthResults(results: MailAuthResults[]): MailAuthResults {
  const merged = results[0] ?? { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', raw: '', ambiguous: false };
  let ambiguous = false;
  for (const mechanism of ['spf', 'dkim', 'dmarc'] as const) {
    const verdicts = new Set(results.map((item) => item[mechanism]).filter((value) => value !== 'unknown'));
    if (verdicts.size > 1) {
      ambiguous = true;
      break;
    }
  }
  return { ...merged, ambiguous };
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function attachmentBytes(attachment: PostalAttachment): Uint8Array {
  if (attachment.content instanceof ArrayBuffer) return new Uint8Array(attachment.content);
  if (attachment.content instanceof Uint8Array) return attachment.content;
  return new TextEncoder().encode(String(attachment.content ?? ''));
}

function parseReferences(value: string): string[] {
  const ids = Array.from(value.matchAll(/<([^<>]+)>/g))
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  if (ids.length > 0) return ids;
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

export async function parseInboundEmail(input: {
  raw: ArrayBuffer;
  envelopeFrom: string;
  envelopeTo: string;
  headers?: Headers;
  threadSecret?: string;
}): Promise<ParsedInbound> {
  const parser = new PostalMime({ attachmentEncoding: 'arraybuffer' });
  const email = await parser.parse(input.raw);
  const from = mailbox(email.from);
  const fromAddress = (input.envelopeFrom || from?.address || '').trim().toLowerCase();
  const fromName = from?.name || fromAddress;
  const subject = (email.subject || '').trim();
  const text = email.text?.trim() || (email.html ? stripHtml(email.html) : '');
  const html = email.html ?? null;

  const auth = mergeAuthResults(authHeaders(email.headers, input.headers).map(parseAuthResults));

  const messageIdHeader = normalizeMessageId(email.messageId ?? '');
  const inReplyTo = normalizeMessageId(email.inReplyTo ?? '');
  const referenceIds = parseReferences(email.references ?? '');
  const messageIdHash = messageIdHeader ? await sha256Hex(messageIdHeader) : '';
  const inReplyToHash = inReplyTo ? await sha256Hex(inReplyTo) : '';
  const referenceHashes = await Promise.all(referenceIds.map((id) => sha256Hex(normalizeMessageId(id))));
  const normalizedSubject = normalizeSubject(subject);
  const subjectKey =
    normalizedSubject && input.threadSecret ? await hmacHex(input.threadSecret, normalizedSubject) : '';

  const attachments: ParsedAttachment[] = email.attachments.map((attachment, index) => {
    const filename = attachment.filename?.trim() || `attachment-${index + 1}`;
    const contentType = (attachment.mimeType || 'application/octet-stream').toLowerCase();
    const blocked =
      BLOCKED_EXTENSIONS.has(extension(filename)) ||
      BLOCKED_MIME.has(contentType) ||
      contentType.startsWith('application/x-ms') ||
      contentType.startsWith('application/x-executable');
    const content = attachmentBytes(attachment);
    return {
      id: crypto.randomUUID(),
      filename,
      contentType,
      content,
      disposition: attachment.disposition ?? null,
      contentId: attachment.contentId ?? null,
      inline: attachment.disposition === 'inline' && Boolean(attachment.contentId),
      blocked,
      sizeBytes: content.byteLength,
    };
  });

  const authFailed = auth.dmarc === 'fail' || auth.dmarc === 'reject' || (auth.spf === 'fail' && auth.dkim === 'fail');
  const blocked = attachments.some((attachment) => attachment.blocked);
  const needsScan = attachments.some((attachment) => !attachment.inline && !attachment.blocked);
  const spamReason = auth.ambiguous
    ? 'auth_conflict'
    : authFailed
      ? 'auth_failed'
      : blocked
        ? 'attachment_blocked'
        : needsScan
          ? 'attachment_scan_unavailable'
          : null;

  return {
    subject: subject || '(No subject)',
    fromName,
    fromAddress,
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    replyTo: addresses(email.replyTo),
    text,
    html,
    snippet: snippet(text),
    date: email.date ?? null,
    attachments,
    auth,
    messageIdHeader,
    inReplyTo,
    referenceIds,
    messageIdHash,
    inReplyToHash,
    referenceHashes,
    subjectKey,
    spam: spamReason !== null,
    spamReason,
  };
}
