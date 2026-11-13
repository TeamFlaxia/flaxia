// Client-side Mail decryption (docs/mail.md §6.2, §9.2).
//
// The Worker stores only ciphertext. This reader unwraps each message's
// content key with the Mail identity private key from the Personal Vault, then
// decrypts metadata and payload JSON. No key or plaintext leaves this module.
import { loadMailIdentityForVersion, type MailIdentityMaterial } from '../vault/mail-identity.js';
import {
  type EncryptedMessageRow,
  type EncryptedThreadList,
  type EncryptedThreadResponse,
  type EncryptedThreadRow,
  fetchMailAttachment,
  fetchMailPayload,
  type MailAttachment,
  type MailMessage,
  type MailSecurity,
  type MailThreadDetail,
  type MailThreadSummary,
} from './api.js';
import { decryptAttachment, decryptPayload, decryptString, metaInfo, unwrapContentKey } from './crypto.js';

export interface MailMetadata {
  subject: string;
  from_name: string;
  snippet: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    inline?: boolean;
    blocked?: boolean;
  }>;
  auth?: { spf?: string; dkim?: string; dmarc?: string; raw?: string };
  spam_reason?: string | null;
}

export interface MailPayload {
  text: string;
  html?: string | null;
}

export interface DecryptedThreadSummary extends MailThreadSummary {
  messageId: string;
}

export interface DecryptedMessage extends MailMessage {
  contentKey: Uint8Array;
  payloadIv: string;
  blobId: string;
  readAt: string | null;
  spamScore: number;
  /** Logical message id used as the AEAD AAD (falls back to the row id). */
  aadId: string;
  messageIdHash: string;
}

export interface DecryptedThread {
  thread: Pick<MailThreadDetail, 'id' | 'subject' | 'security' | 'labels'>;
  messages: DecryptedMessage[];
  attachments: Array<{
    id: string;
    messageId: string;
    aadId: string;
    iv: string;
    contentType: string;
    sizeBytes: number;
    scanStatus: string;
  }>;
}

function toAttachment(
  meta: MailMetadata,
  rows: Array<{ id: string; aad_id: string; iv: string; content_type: string; size_bytes: number }>,
): MailAttachment[] {
  return (meta.attachments ?? []).map((attachment) => {
    const row = rows.find((entry) => (entry.aad_id || entry.id) === attachment.id);
    return {
      id: row?.id ?? attachment.id,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      aad_id: row ? row.aad_id || row.id : attachment.id,
      iv: row?.iv ?? '',
    };
  });
}

export class MailReader {
  private identities = new Map<number, MailIdentityMaterial | null>();

  constructor(private readonly address: string) {}

  private async identity(keyVersion: number): Promise<MailIdentityMaterial | null> {
    if (!this.identities.has(keyVersion)) {
      try {
        this.identities.set(keyVersion, await loadMailIdentityForVersion(keyVersion));
      } catch {
        this.identities.set(keyVersion, null);
      }
    }
    return this.identities.get(keyVersion) ?? null;
  }

  private async contentKey(
    messageId: string,
    wrapped: EncryptedThreadRow['key'],
  ): Promise<{ key: Uint8Array; identity: MailIdentityMaterial } | null> {
    if (!wrapped) return null;
    const identity = await this.identity(wrapped.key_version);
    if (!identity) return null;
    try {
      const key = await unwrapContentKey(
        {
          ephemeralPublicKey: wrapped.ephemeral_public_key,
          iv: wrapped.iv,
          wrappedContentKey: wrapped.wrapped_content_key,
        },
        identity.privateKeyPkcs8B64,
        messageId,
        wrapped.recipient_address || this.address,
      );
      return { key, identity };
    } catch {
      return null;
    }
  }

  async decryptThreadList(list: EncryptedThreadList): Promise<{
    threads: DecryptedThreadSummary[];
    nextCursor?: string;
    counts?: EncryptedThreadList['counts'];
  }> {
    const threads: DecryptedThreadSummary[] = [];
    for (const row of list.threads) {
      const summary = await this.decryptThreadRow(row);
      if (summary) threads.push(summary);
    }
    return { threads, nextCursor: list.next_cursor, counts: list.counts };
  }

  private async decryptThreadRow(row: EncryptedThreadRow): Promise<DecryptedThreadSummary | null> {
    const aadId = row.aad_id || row.message_id;
    const content = await this.contentKey(aadId, row.key);
    if (!content) return null;
    try {
      const meta = await this.decryptMetadata(content.key, aadId, row.meta_enc);
      return {
        id: row.id,
        folder: row.folder,
        subject: meta.subject || '(No subject)',
        snippet: meta.snippet,
        from_name: meta.from_name || row.from_addr,
        from_address: row.from_addr,
        date: row.received_at,
        unread: Number(row.unread_count) > 0,
        starred: Boolean(row.starred_at),
        has_attachment: row.has_attachments || (meta.attachments?.length ?? 0) > 0,
        message_count: Number(row.message_count),
        security: row.security,
        messageId: row.message_id,
      };
    } catch {
      return null;
    } finally {
      content.key.fill(0);
    }
  }

  async decryptThread(response: EncryptedThreadResponse): Promise<DecryptedThread | null> {
    const messages: DecryptedMessage[] = [];
    let subject = '';
    let security: MailSecurity = 'at_rest';

    for (const row of response.messages) {
      const aadId = row.aad_id || row.id;
      const content = await this.contentKey(aadId, row.key);
      if (!content) continue;
      const meta = await this.decryptMetadata(content.key, aadId, row.meta_enc).catch(() => null);
      if (!meta) {
        content.key.fill(0);
        continue;
      }
      if (!subject) subject = meta.subject;
      security = row.security;
      const message: DecryptedMessage = {
        id: row.id,
        from_name: meta.from_name || row.from_addr,
        from_address: row.from_addr,
        to: meta.to ?? (row.to_addr ? [row.to_addr] : []),
        date: row.received_at,
        body_text: '',
        security: row.security,
        attachments: toAttachment(
          meta,
          response.attachments.filter((attachment) => attachment.message_id === row.id),
        ),
        contentKey: content.key,
        payloadIv: row.payload_iv,
        blobId: row.blob_id,
        readAt: row.read_at,
        spamScore: Number(row.spam_score) || 0,
        aadId,
        messageIdHash: row.message_id_hash,
      };
      messages.push(message);
    }

    if (messages.length === 0) return null;
    return {
      thread: { id: response.thread.id, subject: subject || '(No subject)', security, labels: undefined },
      messages,
      attachments: response.attachments.map((attachment) => ({
        id: attachment.id,
        messageId: attachment.message_id,
        aadId: attachment.aad_id || attachment.id,
        iv: attachment.iv ?? '',
        contentType: attachment.content_type,
        sizeBytes: attachment.size_bytes,
        scanStatus: attachment.scan_status,
      })),
    };
  }

  async decryptPayload(message: DecryptedMessage): Promise<MailPayload | null> {
    try {
      const ciphertext = await fetchMailPayload(message.id);
      const plaintext = await decryptPayload(
        message.contentKey,
        message.payloadIv,
        ciphertext,
        message.aadId || message.id,
      );
      return JSON.parse(new TextDecoder().decode(plaintext)) as MailPayload;
    } catch {
      return null;
    }
  }

  private async decryptMetadata(contentKey: Uint8Array, messageId: string, metaEnc: string): Promise<MailMetadata> {
    const plaintext = await decryptString(contentKey, metaEnc, metaInfo(messageId));
    return JSON.parse(plaintext) as MailMetadata;
  }
}

/** Fetch and decrypt one attachment for download. */
export async function downloadAttachment(message: DecryptedMessage, attachment: MailAttachment): Promise<Uint8Array> {
  const ciphertext = await fetchMailAttachment(message.id, attachment.id);
  return decryptAttachment(message.contentKey, attachment.aad_id || attachment.id, attachment.iv ?? '', ciphertext);
}

export type { EncryptedMessageRow };
