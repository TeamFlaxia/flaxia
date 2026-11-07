// Pure client-side envelope sealing for Mail send/draft (docs/mail.md §6.2,
// §9.2). No network and no vault imports so the wire format can be tested in
// isolation (mail-send-seal.test.ts); send.ts adds key lookup and vault access.

import type { SendEnvelopeInput } from './api.ts';
import {
  attachmentNameInfo,
  encodeB64,
  encryptAttachment,
  encryptPayload,
  encryptString,
  fromNameInfo,
  metaInfo,
  subjectInfo,
  wrapContentKey,
} from './crypto.ts';

export const MAX_SEND_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const MAX_RECIPIENTS = 20;

export interface ComposeAttachmentInput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface ComposeFields {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: ComposeAttachmentInput[];
}

export interface SendContext {
  fromName?: string;
  threadId?: string;
  inReplyToHash?: string;
  messageId?: string;
}

export interface RecipientKey {
  address: string;
  public_key: string;
  key_version: number;
}

export interface MailMetadata {
  subject: string;
  from_name: string;
  snippet: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    inline?: boolean;
    blocked?: boolean;
  }>;
}

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

export function uniqueAddresses(lists: Array<string[] | undefined>): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const address of list ?? []) {
      const normalized = normalize(address);
      if (normalized) set.add(normalized);
    }
  }
  return [...set];
}

export function isFlaxiaAddress(address: string, domain = 'flaxia.app'): boolean {
  return address.endsWith(`@${domain}`);
}

/**
 * Seal a composed message into the wire envelope. `keys` must cover every
 * unique recipient plus the sender. Purely local: no network, no vault.
 */
export async function sealEnvelope(
  fields: ComposeFields,
  keys: RecipientKey[],
  context: SendContext = {},
): Promise<SendEnvelopeInput> {
  const messageId = context.messageId ?? crypto.randomUUID();
  const keyByAddress = new Map(keys.map((key) => [normalize(key.address), key]));
  const recipients = uniqueAddresses([fields.to, fields.cc, fields.bcc]);

  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const metaAttachments: Array<{ id: string; filename: string; content_type: string; size_bytes: number }> = [];
    const attachments: NonNullable<SendEnvelopeInput['attachments']> = [];
    let totalBytes = 0;

    for (const attachment of fields.attachments.slice(0, MAX_ATTACHMENTS)) {
      const id = crypto.randomUUID();
      totalBytes += attachment.bytes.byteLength;
      if (totalBytes > MAX_SEND_BYTES) throw new Error('mail_too_large');
      const sealed = await encryptAttachment(contentKey, id, attachment.bytes);
      const filenameEnc = await encryptString(contentKey, attachment.name, attachmentNameInfo(id));
      attachments.push({
        id,
        iv: sealed.iv,
        ciphertext: encodeB64(sealed.ciphertext),
        filename_enc: filenameEnc,
        content_type: attachment.type || 'application/octet-stream',
        size_bytes: attachment.bytes.byteLength,
      });
      metaAttachments.push({
        id,
        filename: attachment.name,
        content_type: attachment.type || 'application/octet-stream',
        size_bytes: attachment.bytes.byteLength,
      });
    }

    const metadata: MailMetadata = {
      subject: fields.subject,
      from_name: context.fromName ?? '',
      snippet: fields.text.slice(0, 160),
      to: fields.to,
      cc: fields.cc,
      attachments: metaAttachments,
    };

    const payloadBytes = new TextEncoder().encode(JSON.stringify({ text: fields.text }));
    const payload = await encryptPayload(contentKey, payloadBytes, messageId);
    totalBytes += payload.ciphertext.byteLength;
    if (totalBytes > MAX_SEND_BYTES) throw new Error('mail_too_large');

    const subjectEnc = await encryptString(contentKey, fields.subject, subjectInfo(messageId));
    const fromNameEnc = await encryptString(contentKey, context.fromName ?? '', fromNameInfo(messageId));
    const metaEnc = await encryptString(contentKey, JSON.stringify(metadata), metaInfo(messageId));

    const wireKeys: SendEnvelopeInput['keys'] = [];
    // Sending to yourself makes `from` a recipient too; wrap once per address.
    for (const address of [...new Set([normalize(fields.from), ...recipients])]) {
      const key = keyByAddress.get(address);
      if (!key) throw new Error('mail_recipient_key_missing');
      const wrapped = await wrapContentKey(contentKey, key.public_key, messageId, address);
      wireKeys.push({
        address,
        key_version: key.key_version,
        ephemeral_public_key: wrapped.ephemeralPublicKey,
        iv: wrapped.iv,
        wrapped_content_key: wrapped.wrappedContentKey,
      });
    }

    return {
      message_id: messageId,
      ...(context.threadId ? { thread_id: context.threadId } : {}),
      ...(context.inReplyToHash ? { in_reply_to_hash: context.inReplyToHash } : {}),
      from: normalize(fields.from),
      to: fields.to.map(normalize),
      cc: fields.cc.map(normalize),
      bcc: fields.bcc.map(normalize),
      subject_enc: subjectEnc,
      from_name_enc: fromNameEnc,
      meta_enc: metaEnc,
      payload: { iv: payload.iv, ciphertext: encodeB64(payload.ciphertext) },
      attachments,
      keys: wireKeys,
    };
  } finally {
    contentKey.fill(0);
  }
}
