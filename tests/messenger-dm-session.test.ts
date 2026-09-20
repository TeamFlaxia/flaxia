import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  __setDmPlaintextStoreForTests,
  clearDmPlaintext,
  getDmPlaintext,
  MemoryDmPlaintextStore,
  putDmPlaintext,
  unwrapStringWithKek,
  wrapStringWithKek,
} from '../src/lib/messenger-dm-cache.ts';
import {
  __clearInMemoryPlaintextCacheForTests,
  __clearSessionsForTests,
  __setSessionForTests,
  buildInitiatorRatchet,
  buildResponderRatchet,
  type DmX3DHBootstrap,
  decryptDmMessageV2,
  encryptDmMessageV2,
  resetDmRatchet,
} from '../src/lib/messenger-dm-session.ts';
import {
  __seedConsumedOpkForTests,
  __setIdentityV2ForTests,
  type IdentityV2,
} from '../src/lib/messenger-identity-v2.ts';
import {
  bufToBase64,
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  type PreKeyBundle,
} from '../src/lib/messenger-x3dh.ts';

function fullIdentity(): IdentityV2 {
  const id = generateIdentityKeyPair();
  const spk = generateSignedPreKey(id.signPriv);
  return {
    identitySignPub: id.signPub,
    identitySignPriv: Uint8Array.from(atob(id.signPriv), (c) => c.charCodeAt(0)),
    identityDhPub: id.dhPub,
    identityDhPriv: Uint8Array.from(atob(id.dhPriv), (c) => c.charCodeAt(0)),
    spkPub: spk.pub,
    spkPriv: Uint8Array.from(atob(spk.priv), (c) => c.charCodeAt(0)),
    spkSig: spk.signature,
  };
}

function peerBundle(me: IdentityV2): { bundle: PreKeyBundle; spkPriv: string; opkPriv: string } {
  const spk = { pub: me.spkPub, priv: bufToBase64(me.spkPriv) };
  const opk = generateOneTimePreKeys(1)[0];
  return {
    bundle: {
      identitySignPub: me.identitySignPub,
      identityDhPub: me.identityDhPub,
      signedPreKeyPub: spk.pub,
      signedPreKeySignature: me.spkSig,
      preKeyPub: opk.pub,
      preKeyId: opk.id,
    },
    spkPriv: spk.priv,
    opkPriv: opk.priv,
  };
}

describe('E2EE v2 DM session (X3DH + Double Ratchet)', () => {
  it('establishes a session and exchanges messages both ways', () => {
    const A = fullIdentity();
    const B = fullIdentity();
    const b = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    const env1 = aBuilt.ratchet.encrypt('hello bob');
    const bootstrap: DmX3DHBootstrap = aBuilt.bootstrap;

    const bRatchet = buildResponderRatchet(B, b.opkPriv, bootstrap);
    assert.equal(bRatchet.decrypt({ header: env1.header, ciphertext: env1.ciphertext }), 'hello bob');

    const env2 = bRatchet.encrypt('hi alice');
    assert.equal(aBuilt.ratchet.decrypt({ header: env2.header, ciphertext: env2.ciphertext }), 'hi alice');
  });

  it('survives a longer back-and-forth with multiple messages', () => {
    const A = fullIdentity();
    const B = fullIdentity();
    const b = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    const aRatchet = aBuilt.ratchet;
    const bRatchet = buildResponderRatchet(B, b.opkPriv, aBuilt.bootstrap);

    const aToB: string[] = [];
    const bToA: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ea = aRatchet.encrypt(`a${i}`);
      aToB.push(ea.ciphertext);
      assert.equal(bRatchet.decrypt({ header: ea.header, ciphertext: ea.ciphertext }), `a${i}`);
      const eb = bRatchet.encrypt(`b${i}`);
      bToA.push(eb.ciphertext);
      assert.equal(aRatchet.decrypt({ header: eb.header, ciphertext: eb.ciphertext }), `b${i}`);
    }
  });

  it('rejects decryption by a non-participant', () => {
    const A = fullIdentity();
    const B = fullIdentity();
    const C = fullIdentity();
    const b = peerBundle(B);

    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    const aRatchet = aBuilt.ratchet;
    const env = aRatchet.encrypt('secret');
    const cRatchet = buildResponderRatchet(C, b.opkPriv, aBuilt.bootstrap);
    assert.throws(() => cRatchet.decrypt({ header: env.header, ciphertext: env.ciphertext }));
  });
});

// Real CryptoKey for the KEK slot so consumeOwnOpkPriv reaches its cache.
async function testKek(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

describe('DM session recovery (candidate sessions)', () => {
  it('a replayed old bootstrap never clobbers the live session', async () => {
    const A = fullIdentity();
    const B = fullIdentity();
    __clearSessionsForTests();
    __setIdentityV2ForTests(B, await testKek());

    // Session #1 (abandoned): its first message stays in history forever.
    const b1 = peerBundle(B);
    const aInit1 = buildInitiatorRatchet(A, b1.bundle);
    const mOld = aInit1.ratchet.encrypt('session one hello');

    // Session #2: the live session, injected as the only candidate.
    const b2 = peerBundle(B);
    const aInit2 = buildInitiatorRatchet(A, b2.bundle);
    const liveB = buildResponderRatchet(B, b2.opkPriv, aInit2.bootstrap);
    __setSessionForTests('dm-replay', 'alice', liveB);

    // Both OPKs resolvable — exactly the state right after each handshake.
    __seedConsumedOpkForTests(b1.bundle.preKeyId ?? '', b1.opkPriv);
    __seedConsumedOpkForTests(b2.bundle.preKeyId ?? '', b2.opkPriv);

    // Live traffic works.
    const e1 = aInit2.ratchet.encrypt('live msg');
    assert.equal(
      await decryptDmMessageV2('dm-replay', 'alice', JSON.stringify({ ct: e1.ciphertext }), e1.header),
      'live msg',
    );

    // Re-render replays the OLD bootstrap-bearing message. The old code
    // rebuilt the responder ratchet from it (OPK obtainable!) and REPLACED
    // the live session; now it must decrypt via a separate candidate.
    const oldPt = await decryptDmMessageV2(
      'dm-replay',
      'alice',
      JSON.stringify({ ct: mOld.ciphertext, x3dh: aInit1.bootstrap }),
      mOld.header,
    );
    assert.equal(oldPt, 'session one hello');

    // ...and the live session still works afterwards.
    const e2 = aInit2.ratchet.encrypt('after replay');
    assert.equal(
      await decryptDmMessageV2('dm-replay', 'alice', JSON.stringify({ ct: e2.ciphertext }), e2.header),
      'after replay',
    );

    // Interleaved replays keep working both ways too.
    assert.equal(
      await decryptDmMessageV2('dm-replay', 'alice', JSON.stringify({ ct: e1.ciphertext }), e1.header),
      'live msg',
    );
  });

  it('a missing OPK on an orphaned bootstrap stays OPK_UNRECOVERABLE', async () => {
    const A = fullIdentity();
    const B = fullIdentity();
    __clearSessionsForTests();
    __setIdentityV2ForTests(B, await testKek());

    const b = peerBundle(B);
    const aInit = buildInitiatorRatchet(A, b.bundle);
    const mOld = aInit.ratchet.encrypt('orphan');

    // No session injected, OPK private not seeded (server deleted it).
    await assert.rejects(
      decryptDmMessageV2(
        'dm-orphan',
        'alice',
        JSON.stringify({ ct: mOld.ciphertext, x3dh: aInit.bootstrap }),
        mOld.header,
      ),
      /OPK_UNRECOVERABLE/,
    );
  });
});

describe('DM ratchet reset', () => {
  it('never clears the durable decrypted history (the ratchet cannot recompute it)', async () => {
    __setDmPlaintextStoreForTests(new MemoryDmPlaintextStore());
    __setIdentityV2ForTests(await fullIdentityNoKeys(), await testKek());
    await putDmPlaintext('dm-keep:peer:pub:0', 'precious history');

    await resetDmRatchet('dm-keep', 'peer');

    assert.equal(await getDmPlaintext('dm-keep:peer:pub:0'), 'precious history');
  });

  it('waits for the server delete so the next send re-bootstraps instead of resurrecting the old session', async () => {
    const A = fullIdentity();
    const B = fullIdentity();
    __clearSessionsForTests();
    __setIdentityV2ForTests(A, await testKek());

    const b = peerBundle(B);
    const dmId = 'dm-reset-race';
    const peerId = 'bob';

    // A valid persisted initiator session: the old code would load and reuse it.
    const aBuilt = buildInitiatorRatchet(A, b.bundle);
    aBuilt.ratchet.encrypt('stale');
    const persisted = await wrapStringWithKek(
      JSON.stringify([{ ratchet: aBuilt.ratchet.serialize(), bootstrap: null }]),
    );

    let deleted = false;
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (input: unknown, init: Record<string, unknown> = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET').toUpperCase();
      if (url.includes('/api/messenger/ratchet-session')) {
        if (method === 'DELETE') {
          await deleteGate;
          deleted = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (method === 'PUT') return new Response(JSON.stringify({ success: true }), { status: 200 });
        if (deleted) return new Response(JSON.stringify({ exists: false }), { status: 200 });
        return new Response(JSON.stringify({ exists: true, session_enc: persisted.enc, session_iv: persisted.iv }), {
          status: 200,
        });
      }
      if (url.includes('/api/messenger/prekeys')) {
        return new Response(
          JSON.stringify({
            identitySignPub: B.identitySignPub,
            identityDhPub: B.identityDhPub,
            signedPreKeyPub: B.spkPub,
            signedPreKeySignature: B.spkSig,
            signedPreKeyRotatedAt: new Date().toISOString(),
            preKeyPub: b.bundle.preKeyPub,
            preKeyId: b.bundle.preKeyId,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const resetPromise = resetDmRatchet(dmId, peerId);
      const encPromise = encryptDmMessageV2(dmId, peerId, 'fresh');
      let settled = false;
      void encPromise.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(settled, false, 'send waits for the pending server reset');
      releaseDelete();
      await resetPromise;
      const env = await encPromise;
      assert.ok(env.x3dh, 'send re-bootstraps X3DH instead of reusing the deleted session');
    } finally {
      (globalThis as Record<string, unknown>).fetch = realFetch;
    }
  });
});

describe('Durable DM plaintext cache (reload recovery)', () => {
  it('persists decrypted peer plaintext and survives an in-memory cache clear', async () => {
    const A = fullIdentity();
    const B = fullIdentity();
    __clearSessionsForTests();
    __setDmPlaintextStoreForTests(new MemoryDmPlaintextStore());
    __setIdentityV2ForTests(B, await testKek());

    const b = peerBundle(B);
    const aInit = buildInitiatorRatchet(A, b.bundle);
    const env = aInit.ratchet.encrypt('peer secret');
    const bRatchet = buildResponderRatchet(B, b.opkPriv, aInit.bootstrap);
    __setSessionForTests('dm-cache', 'alice', bRatchet);

    // First decrypt succeeds and is cached durably.
    const pt1 = await decryptDmMessageV2(
      'dm-cache',
      'alice',
      JSON.stringify({ ct: env.ciphertext, x3dh: aInit.bootstrap }),
      env.header,
    );
    assert.equal(pt1, 'peer secret');

    // Simulate a reload: the in-memory cache is gone but the ratchet has already
    // consumed this message, so re-derivation would fail without the store.
    __clearInMemoryPlaintextCacheForTests();
    const pt2 = await decryptDmMessageV2(
      'dm-cache',
      'alice',
      JSON.stringify({ ct: env.ciphertext, x3dh: aInit.bootstrap }),
      env.header,
    );
    assert.equal(pt2, 'peer secret');
  });

  it('store round-trips and clears only the requested conversation', async () => {
    __setDmPlaintextStoreForTests(new MemoryDmPlaintextStore());
    await putDmPlaintext('dm1:a:pub:0', 'hi');
    await putDmPlaintext('dm1:a:pub:1', 'yo');
    await putDmPlaintext('dm2:b:pub:0', 'nope');

    assert.equal(await getDmPlaintext('dm1:a:pub:0'), 'hi');
    assert.equal(await getDmPlaintext('dm1:a:pub:1'), 'yo');
    assert.equal(await getDmPlaintext('dm2:b:pub:0'), 'nope');
    assert.equal(await getDmPlaintext('dm1:a:pub:9'), null);

    await clearDmPlaintext('dm1');
    assert.equal(await getDmPlaintext('dm1:a:pub:0'), null);
    assert.equal(await getDmPlaintext('dm1:a:pub:1'), null);
    // Other conversations untouched.
    assert.equal(await getDmPlaintext('dm2:b:pub:0'), 'nope');
  });

  it('KEK-wrapped string plaintext round-trips (cross-device backup)', async () => {
    __setIdentityV2ForTests(await fullIdentityNoKeys(), await testKek());
    const secret = 'top secret cross-device text';
    const wrapped = await wrapStringWithKek(secret);
    assert.notEqual(wrapped.enc, secret);
    assert.equal(await unwrapStringWithKek(wrapped.enc, wrapped.iv), secret);
  });
});

// A minimal identity (keys unused here) so getE2EEK() returns the test KEK for
// the string wrap/unwrap round-trip above.
async function fullIdentityNoKeys(): Promise<IdentityV2> {
  const id = generateIdentityKeyPair();
  return {
    identitySignPub: id.signPub,
    identitySignPriv: Uint8Array.from(atob(id.signPriv), (c) => c.charCodeAt(0)),
    identityDhPub: id.dhPub,
    identityDhPriv: Uint8Array.from(atob(id.dhPriv), (c) => c.charCodeAt(0)),
    spkPub: '',
    spkPriv: new Uint8Array(0),
    spkSig: '',
  };
}
