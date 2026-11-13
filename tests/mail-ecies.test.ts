// ECIES wrap/unwrap round trip + known-answer shape (docs/mail.md §6.2, §12).
//
// The wrap info string and AAD bind message_id + recipient_address; changing
// either must fail to unwrap. Attachment keys are derived via HKDF from the
// content key and differ per attachment id.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachmentKeyInfo,
  decryptPayload,
  deriveAttachmentKey,
  encodeB64,
  encryptPayload,
  unwrapContentKey,
  wrapContentKey,
  wrapInfo,
} from '../src/lib/mail/crypto.ts';

const subtle = (globalThis.crypto as Crypto).subtle;

async function makeP256Pair(): Promise<{ spkiB64: string; pkcs8B64: string }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  return { spkiB64: encodeB64(spki), pkcs8B64: encodeB64(pkcs8) };
}

describe('mail ECIES', () => {
  it('round-trips a content key wrap', async () => {
    const recipient = await makeP256Pair();
    const sender = await makeP256Pair();
    void sender;
    const contentKey = crypto.getRandomValues(new Uint8Array(32));
    const messageId = 'msg-123';
    const recipientAddress = 'alice@flaxia.app';
    const wrapped = await wrapContentKey(contentKey, recipient.spkiB64, messageId, recipientAddress);
    assert.ok(wrapped.ephemeralPublicKey);
    assert.ok(wrapped.iv);
    assert.ok(wrapped.wrappedContentKey);
    const unwrapped = await unwrapContentKey(wrapped, recipient.pkcs8B64, messageId, recipientAddress);
    assert.deepEqual(Array.from(unwrapped), Array.from(contentKey));
  });

  it('binds the wrap to message + recipient (AAD)', async () => {
    const recipient = await makeP256Pair();
    const contentKey = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapContentKey(contentKey, recipient.spkiB64, 'msg-123', 'alice@flaxia.app');
    await assert.rejects(unwrapContentKey(wrapped, recipient.pkcs8B64, 'msg-456', 'alice@flaxia.app'), Error);
    await assert.rejects(unwrapContentKey(wrapped, recipient.pkcs8B64, 'msg-123', 'bob@flaxia.app'), Error);
  });

  it('uses the spec info strings', () => {
    assert.equal(wrapInfo('m1', 'a@flaxia.app'), 'flaxia.mail.wrap.v1:m1:a@flaxia.app');
    assert.equal(attachmentKeyInfo('att1'), 'flaxia.mail.attachment.v1:att1');
  });

  it('derives distinct attachment keys per attachment id', async () => {
    const contentKey = crypto.getRandomValues(new Uint8Array(32));
    const a = await deriveAttachmentKey(contentKey, 'att-a');
    const b = await deriveAttachmentKey(contentKey, 'att-b');
    assert.equal(a.length, 32);
    assert.notDeepEqual(Array.from(a), Array.from(b));
    const a2 = await deriveAttachmentKey(contentKey, 'att-a');
    assert.deepEqual(Array.from(a), Array.from(a2));
  });

  it('round-trips payload encryption', async () => {
    const contentKey = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode('hello flaxia mail');
    const { iv, ciphertext } = await encryptPayload(contentKey, plaintext, 'msg-1');
    const recovered = await decryptPayload(contentKey, iv, ciphertext, 'msg-1');
    assert.deepEqual(new TextDecoder().decode(recovered), 'hello flaxia mail');
    await assert.rejects(decryptPayload(contentKey, iv, ciphertext, 'msg-2'), Error);
  });
});
