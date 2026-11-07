// Client-side Mail send/draft wiring (docs/mail.md §6.2, §9.2, §10).
//
// Envelope sealing itself lives in seal.ts (pure). This module adds recipient
// key lookup, refusal of external recipients until the SMTP path ships, and
// encrypted-draft reopen through the Personal Vault.

import { loadMailIdentityForVersion } from '../vault/mail-identity.js';
import {
  fetchDraftAttachment,
  fetchDraftPayload,
  fetchKeysForAddresses,
  getDraft,
  type MailAttachment,
  type SendEnvelopeInput,
  saveDraft,
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

/**
 * Resolve keys and seal a message for delivery. Any external (or key-less)
 * recipient is refused instead of silently downgrading the message to plaintext;
 * the TLS/external path arrives with M2.
 */
export async function buildOutgoingEnvelope(
  fields: ComposeFields,
  context: SendContext = {},
): Promise<SendEnvelopeInput> {
  const recipients = uniqueAddresses([fields.to, fields.cc, fields.bcc]);
  const address = normalize(fields.from);
  const domain = address.split('@')[1] ?? 'flaxia.app';
  if (recipients.some((recipient) => !isFlaxiaAddress(recipient, domain))) {
    throw new Error('mail_external_unavailable');
  }
  const keys = await resolveKeys([address, ...recipients]);
  for (const recipient of recipients) {
    if (!keys.has(recipient)) throw new Error('mail_external_unavailable');
  }
  const self = keys.get(address);
  if (!self) throw new Error('mail_not_activated');
  return sealEnvelope(fields, [...keys.values()], context);
}

export async function sendCompose(fields: ComposeFields, context: SendContext = {}): Promise<void> {
  const envelope = await buildOutgoingEnvelope(fields, context);
  await sendMessage(envelope);
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
  const envelope = await sealEnvelope(fields, [self], { ...context, messageId: draftId ?? context.messageId });
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
