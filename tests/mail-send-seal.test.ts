// Wire-format contract for the client sealer (src/lib/mail/seal.ts). Verifies
// the envelope decrypts for every recipient with only their vault key, that the
// AEAD AAD is the logical message id (so mailbox fan-out copies decrypt), and
// that attachment names/bytes stay sealed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decryptAttachment,
  decryptPayload,
  decryptString,
  metaInfo,
  subjectInfo,
  unwrapContentKey,
} from '../src/lib/mail/crypto.ts';
import {
  type ComposeFields,
  MAX_ATTACHMENTS,
  MAX_SEND_BYTES,
  type RecipientKey,
  sealEnvelope,
  uniqueAddresses,
} from '../src/lib/mail/seal.ts';

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

interface Identity {
  address: string;
  spki: string;
  pkcs8: string;
}

async function makeIdentity(local: string): Promise<Identity> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { address: `${local}@flaxia.app`, spki: b64(spki), pkcs8: b64(pkcs8) };
}

function keyOf(identity: Identity): RecipientKey {
  return { address: identity.address, public_key: identity.spki, key_version: 1 };
}

function fields(partial: Partial<ComposeFields> = {}): ComposeFields {
  return {
    from: 'alice@flaxia.app',
    to: ['bob@flaxia.app'],
    cc: [],
    bcc: [],
    subject: 'Quarterly plan',
    text: 'The secret body.',
    attachments: [],
    ...partial,
  };
}

async function openFor(identity: Identity, envelope: Awaited<ReturnType<typeof sealEnvelope>>) {
  const key = envelope.keys.find((entry) => entry.address === identity.address);
  assert.ok(key, `wrapped key for ${identity.address}`);
  const contentKey = await unwrapContentKey(
    {
      ephemeralPublicKey: key.ephemeral_public_key,
      iv: key.iv,
      wrappedContentKey: key.wrapped_content_key,
    },
    identity.pkcs8,
    envelope.message_id,
    identity.address,
  );
  return contentKey;
}

describe('mail send sealing', () => {
  it('deduplicates and lowercases recipient lists', () => {
    assert.deepEqual(uniqueAddresses([['A@flaxia.app', 'b@flaxia.app'], ['a@flaxia.app'], undefined]), [
      'a@flaxia.app',
      'b@flaxia.app',
    ]);
  });

  it('lets every recipient and the sender open the sealed message', async () => {
    const alice = await makeIdentity('alice');
    const bob = await makeIdentity('bob');
    const carol = await makeIdentity('carol');
    const envelope = await sealEnvelope(
      fields({
        cc: ['carol@flaxia.app'],
        attachments: [{ name: 'plan.txt', type: 'text/plain', bytes: new TextEncoder().encode('attached') }],
      }),
      [keyOf(alice), keyOf(bob), keyOf(carol)],
      { fromName: 'Alice' },
    );

    assert.deepEqual(envelope.keys.map((key) => key.address).sort(), [
      'alice@flaxia.app',
      'bob@flaxia.app',
      'carol@flaxia.app',
    ]);
    assert.equal(envelope.attachments?.length, 1);
    assert.ok(envelope.attachments?.[0]?.filename_enc.includes('.'), 'filename is sealed');

    for (const identity of [alice, bob, carol]) {
      const contentKey = await openFor(identity, envelope);
      const payload = await decryptPayload(
        contentKey,
        envelope.payload.iv,
        new Uint8Array(Buffer.from(envelope.payload.ciphertext, 'base64')),
        envelope.message_id,
      );
      assert.deepEqual(JSON.parse(new TextDecoder().decode(payload)), { text: 'The secret body.' });
      const subject = await decryptString(contentKey, envelope.subject_enc, subjectInfo(envelope.message_id));
      assert.equal(subject, 'Quarterly plan');
      const meta = JSON.parse(await decryptString(contentKey, envelope.meta_enc, metaInfo(envelope.message_id))) as {
        from_name: string;
        attachments: Array<{ id: string; filename: string }>;
      };
      assert.equal(meta.from_name, 'Alice');
      assert.equal(meta.attachments[0]?.filename, 'plan.txt');

      const attachment = envelope.attachments?.[0];
      assert.ok(attachment);
      const plaintext = await decryptAttachment(
        contentKey,
        attachment.id,
        attachment.iv,
        new Uint8Array(Buffer.from(attachment.ciphertext, 'base64')),
      );
      assert.equal(new TextDecoder().decode(plaintext), 'attached');
      contentKey.fill(0);
    }
  });

  it('wraps the sender key once when messaging yourself', async () => {
    const alice = await makeIdentity('alice');
    const envelope = await sealEnvelope(fields({ to: ['alice@flaxia.app'] }), [keyOf(alice)]);
    assert.equal(envelope.keys.length, 1);
    assert.equal(envelope.keys[0]?.address, 'alice@flaxia.app');
  });

  it('seals drafts for the sender only', async () => {
    const alice = await makeIdentity('alice');
    const envelope = await sealEnvelope(fields({ to: [], subject: 'WIP' }), [keyOf(alice)], {
      messageId: 'draft-id-1',
    });
    assert.equal(envelope.message_id, 'draft-id-1');
    assert.equal(envelope.keys.length, 1);
    const contentKey = await openFor(alice, envelope);
    contentKey.fill(0);
  });

  it('refuses to seal without a key for every recipient', async () => {
    const alice = await makeIdentity('alice');
    await assert.rejects(
      sealEnvelope(fields({ to: ['bob@flaxia.app'] }), [keyOf(alice)]),
      /mail_recipient_key_missing/,
    );
  });

  it('caps attachment count and total size', async () => {
    const alice = await makeIdentity('alice');
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => ({
      name: `f${index}.bin`,
      type: 'application/octet-stream',
      bytes: new Uint8Array([1]),
    }));
    // The extra attachment is dropped by the sealer rather than sent.
    const envelope = await sealEnvelope(fields({ to: [], attachments: many }), [keyOf(alice)]);
    assert.equal(envelope.attachments?.length, MAX_ATTACHMENTS);

    await assert.rejects(
      sealEnvelope(
        fields({
          to: [],
          attachments: [
            { name: 'big.bin', type: 'application/octet-stream', bytes: new Uint8Array(MAX_SEND_BYTES + 1) },
          ],
        }),
        [keyOf(alice)],
      ),
      /mail_too_large/,
    );
  });
});
