// Client-side Mail send/draft wiring (docs/mail.md §6.2, §9.2, §10).
//
// Envelope sealing itself lives in seal.ts (pure). This module adds recipient
// key lookup, the internal E2EE vs external TLS branch, and encrypted-draft
// reopen through the Personal Vault.

import { loadMailIdentityForVersion } from '../vault/mail-identity.js';
import {
  fetchDraftAttachment,
  fetchDraftPayload,
  fetchKeysForAddresses,
  getDraft,
  type MailAttachment,
  type SendEnvelopeInput,
  saveDraft,
  sendExternalMessage,
  sendMessage,
  updateDraft,
} from './api.js';
import { decryptAttachment, decryptPayload, decryptString, metaInfo, unwrapContentKey } from './crypto.js';
import {
  type ComposeAttachmentInput,
  type ComposeFields,
  isFlaxiaAddress,
  type MailMetadata,
  type RecipientKey,
  type SendContext,
  sealEnvelope,
  uniqueAddresses,
} from './seal.js';

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

async function resolveKeys(addresses: string[]): Promise<Map<string, RecipientKey>> {
  const result = await fetchKeysForAddresses(addresses);
  const map = new Map<string, RecipientKey>();
  for (const key of result.keys ?? []) {
    map.set(normalize(key.address), { ...key, address: normalize(key.address) });
  }
  return map;
}

function hasExternalRecipient(fields: ComposeFields): boolean {
  const address = normalize(fields.from);
  const domain = address.split('@')[1] ?? 'flaxia.app';
  return uniqueAddresses([fields.to, fields.cc, fields.bcc]).some((recipient) => !isFlaxiaAddress(recipient, domain));
}

function assertNoHeaderInjection(value: string): void {
  if (value.includes('\r') || value.includes('\n')) throw new Error('mail_header_injection');
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/**
 * Resolve keys and seal a message for delivery. When every recipient is a
 * Flaxia user with a key this is the internal E2EE envelope. Anything else
 * (external address or key-less Flaxia address) takes the TLS path: the
 * client keeps only a sender-retained Sent copy sealed and asks the Worker
 * to deliver plaintext over TLS (docs/mail.md §9.2). The UI must show
 * `TLS only` for the latter — never `E2EE`.
 */
export async function buildOutgoingEnvelope(
  fields: ComposeFields,
  context: SendContext = {},
): Promise<SendEnvelopeInput> {
  const recipients = uniqueAddresses([fields.to, fields.cc, fields.bcc]);
  const address = normalize(fields.from);
  if (hasExternalRecipient(fields)) throw new Error('mail_external_unavailable');
  const keys = await resolveKeys([address, ...recipients]);
  for (const recipient of recipients) {
    if (!keys.has(recipient)) throw new Error('mail_external_unavailable');
  }
  const self = keys.get(address);
  if (!self) throw new Error('mail_not_activated');
  return sealEnvelope(fields, [...keys.values()], context);
}

export async function sendCompose(fields: ComposeFields, context: SendContext = {}): Promise<void> {
  const recipients = uniqueAddresses([fields.to, fields.cc, fields.bcc]);
  if (recipients.length === 0) throw new Error('mail_no_recipients');
  const address = normalize(fields.from);

  if (!hasExternalRecipient(fields)) {
    // A key-less Flaxia address cannot be reached by E2EE; fall through to
    // the TLS branch below (which seals only a Sent copy) instead of
    // failing, so the message still delivers — as TLS, never E2EE.
    const flaxiaRecipients = recipients.filter((recipient) =>
      isFlaxiaAddress(recipient, address.split('@')[1] ?? 'flaxia.app'),
    );
    const keys = await resolveKeys([address, ...flaxiaRecipients]);
    if (flaxiaRecipients.every((recipient) => keys.has(recipient))) {
      const envelope = await buildOutgoingEnvelope(fields, context);
      await sendMessage(envelope);
      return;
    }
  }

  // TLS path: external address or key-less recipient present.
  const selfKeys = await resolveKeys([address]);
  const self = selfKeys.get(address);
  if (!self) throw new Error('mail_not_activated');
  for (const value of [fields.from, fields.subject, context.fromName ?? '', ...recipients]) {
    assertNoHeaderInjection(value);
  }
  for (const attachment of fields.attachments) {
    assertNoHeaderInjection(attachment.name);
    assertNoHeaderInjection(attachment.type);
  }
  const textBytes = new TextEncoder().encode(fields.text).length;
  const attachmentBytes = fields.attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0);
  if (textBytes + attachmentBytes > 10 * 1024 * 1024) throw new Error('mail_too_large');
  if (fields.attachments.length > 20) throw new Error('mail_too_many_attachments');

  const retained = await sealEnvelope(fields, [self], context, { wrapAddresses: [address] });
  await sendExternalMessage({
    message_id: retained.message_id,
    ...(retained.thread_id !== undefined ? { thread_id: retained.thread_id } : {}),
    ...(retained.in_reply_to_hash !== undefined ? { in_reply_to_hash: retained.in_reply_to_hash } : {}),
    from: address,
    from_name: context.fromName ?? '',
    to: fields.to.map(normalize),
    cc: fields.cc.map(normalize),
    bcc: fields.bcc.map(normalize),
    subject: fields.subject,
    text: fields.text,
    attachments: fields.attachments.map((attachment) => ({
      filename: attachment.name,
      content_type: attachment.type || 'application/octet-stream',
      data_b64: bytesToB64(attachment.bytes),
    })),
    retained,
  });
}

/** Save (or update) an encrypted draft. Drafts may address external people. */
export async function saveComposeDraft(
  fields: ComposeFields,
  context: SendContext = {},
  draftId?: string,
): Promise<string> {
  const address = normalize(fields.from);
  const keys = await resolveKeys([address]);
  const self = keys.get(address);
  if (!self) throw new Error('mail_not_activated');
  const envelope = await sealEnvelope(
    fields,
    [self],
    { ...context, messageId: draftId ?? context.messageId },
    {
      wrapAddresses: [address],
    },
  );
  if (draftId) {
    const result = await updateDraft(draftId, envelope);
    return result.draft_id ?? draftId;
  }
  const result = await saveDraft(envelope);
  return result.draft_id ?? envelope.message_id;
}

/** Decrypt a stored draft back into compose fields (vault must be unlocked). */
export async function openDraft(draftId: string): Promise<{ fields: ComposeFields; draftId: string }> {
  const detail = await getDraft(draftId);
  const row = detail.draft;
  if (!row.key) throw new Error('mail_key_unavailable');
  const identity = await loadMailIdentityForVersion(row.key.key_version).catch(() => null);
  if (!identity) throw new Error('mail_key_unavailable');
  const aadId = row.aad_id || row.id;
  const contentKey = await unwrapContentKey(
    {
      ephemeralPublicKey: row.key.ephemeral_public_key,
      iv: row.key.iv,
      wrappedContentKey: row.key.wrapped_content_key,
    },
    identity.privateKeyPkcs8B64,
    aadId,
    row.key.recipient_address || row.from_addr,
  );
  try {
    const meta = JSON.parse(await decryptString(contentKey, row.meta_enc, metaInfo(aadId))) as MailMetadata;
    const payloadCiphertext = await fetchDraftPayload(draftId);
    const payloadBytes = await decryptPayload(contentKey, row.payload_iv, payloadCiphertext, aadId);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { text?: string };

    const attachments: ComposeAttachmentInput[] = [];
    for (const attachment of detail.attachments) {
      const aadAttachmentId = attachment.aad_id || attachment.id;
      const ciphertext = await fetchDraftAttachment(draftId, attachment.id);
      const plaintext = await decryptAttachment(contentKey, aadAttachmentId, attachment.iv, ciphertext);
      const info = (meta.attachments ?? []).find((entry) => entry.id === aadAttachmentId);
      attachments.push({
        name: info?.filename ?? 'attachment',
        type: attachment.content_type,
        bytes: plaintext,
      });
    }

    return {
      draftId,
      fields: {
        from: row.from_addr,
        to: meta.to ?? [],
        cc: meta.cc ?? [],
        bcc: [],
        subject: meta.subject ?? '',
        text: payload.text ?? '',
        attachments,
      },
    };
  } finally {
    contentKey.fill(0);
  }
}

/** Decrypt a received attachment for download (docs/mail.md §6.2). */
export async function decryptMailAttachment(
  contentKey: Uint8Array,
  attachment: MailAttachment,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const aadId = attachment.aad_id || attachment.id;
  if (!attachment.iv) throw new Error('mail_attachment_unavailable');
  return decryptAttachment(contentKey, aadId, attachment.iv, ciphertext);
}
