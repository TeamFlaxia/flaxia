// End-to-end test of the actual X3DH + Double Ratchet code paths used by DMs.
// Run with: npx ts-node --esm --experimental-specifier-resolution=node test/ratchet-e2e.ts
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { DoubleRatchet } from '../src/lib/messenger-ratchet.ts';
import {
  bufToBase64,
  deriveInitialRatchet,
  type PreKeyBundle,
  x3dhInitiate,
  x3dhRespond,
} from '../src/lib/messenger-x3dh.ts';

function freshRatchetPair() {
  const k = x25519.keygen();
  return { secretKey: k.secretKey, publicKey: k.publicKey };
}

function makeIdentity() {
  const dh = x25519.keygen();
  const spk = x25519.keygen();
  const sign = ed25519.keygen();
  return {
    identityDhPriv: dh.secretKey,
    identityDhPub: x25519.getPublicKey(dh.secretKey),
    spkPriv: spk.secretKey,
    spkPub: x25519.getPublicKey(spk.secretKey),
    signPriv: sign.secretKey,
    signPub: sign.publicKey,
  };
}

// Build a validly-signed prekey bundle for `bob` (the real X3DH initiator now
// rejects bundles whose SPK signature does not verify).
function signedBundle(bob: ReturnType<typeof makeIdentity>, extra: Partial<PreKeyBundle> = {}): PreKeyBundle {
  return {
    identitySignPub: bufToBase64(bob.signPub),
    identityDhPub: bufToBase64(bob.identityDhPub),
    signedPreKeyPub: bufToBase64(bob.spkPub),
    signedPreKeySignature: bufToBase64(ed25519.sign(bob.spkPub, bob.signPriv)),
    ...extra,
  };
}

function buildInitiator(me: ReturnType<typeof makeIdentity>, peer: PreKeyBundle) {
  const init = x3dhInitiate(bufToBase64(me.identityDhPriv), bufToBase64(me.identityDhPub), peer);
  const { rootKey, chainKey } = deriveInitialRatchet(init.sharedKey);
  const pair = freshRatchetPair();
  const ratchet = new DoubleRatchet({
    rootKey,
    associatedData: init.associatedData,
    sendRatchetPriv: pair.secretKey,
    sendRatchetPub: pair.publicKey,
    recvRatchetPub: null,
    initialSendChainKey: chainKey,
  });
  return {
    ratchet,
    bootstrap: { ikDhPub: bufToBase64(me.identityDhPub), ekPub: init.ephemeralPub, opkId: init.preKeyId || '' },
  };
}

function buildResponder(
  me: ReturnType<typeof makeIdentity>,
  opkPrivB64: string | null,
  bootstrap: { ikDhPub: string; ekPub: string; opkId: string },
) {
  const resp = x3dhRespond(
    bufToBase64(me.identityDhPriv),
    bufToBase64(me.identityDhPub),
    bufToBase64(me.spkPriv),
    opkPrivB64,
    bootstrap.ikDhPub,
    bootstrap.ekPub,
  );
  const { rootKey, chainKey } = deriveInitialRatchet(resp.sharedKey);
  const pair = freshRatchetPair();
  return new DoubleRatchet({
    rootKey,
    associatedData: resp.associatedData,
    sendRatchetPriv: pair.secretKey,
    sendRatchetPub: pair.publicKey,
    recvRatchetPub: null,
    initialRecvChainKey: chainKey,
  });
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    console.error('  FAIL:', msg);
    failures++;
  }
}

function run() {
  console.log('=== Test 1: full X3DH + Double Ratchet (correct, OPK present) ===');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const opk = x25519.keygen();
    const opkId = 'opk-1';
    const bundle: PreKeyBundle = signedBundle(bob, {
      preKeyPub: bufToBase64(x25519.getPublicKey(opk.secretKey)),
      preKeyId: opkId,
    });
    const a = buildInitiator(alice, bundle);
    const b = buildResponder(bob, bufToBase64(opk.secretKey), a.bootstrap);

    const m1 = a.ratchet.encrypt('hello from alice');
    assert(b.decrypt(m1) === 'hello from alice', 'bob decrypts alice msg 1');
    const m2 = b.encrypt('hi from bob');
    assert(a.ratchet.decrypt(m2) === 'hi from bob', 'alice decrypts bob msg 1');
    const m3 = a.ratchet.encrypt('alice again');
    assert(b.decrypt(m3) === 'alice again', 'bob decrypts alice msg 2');
    const m4 = b.encrypt('bob again');
    assert(a.ratchet.decrypt(m4) === 'bob again', 'alice decrypts bob msg 2');

    // serialize / deserialize round trip
    const a2 = DoubleRatchet.deserialize(a.ratchet.serialize());
    const m5 = a2.encrypt('after serialize');
    assert(b.decrypt(m5) === 'after serialize', 'bob decrypts alice msg after serialize');
    const m6 = b.encrypt('bob after serialize');
    assert(a2.decrypt(m6) === 'bob after serialize', 'alice(after serialize) decrypts bob');

    // decryptOwn (own sent message)
    const m7 = a.ratchet.encrypt('my own message');
    assert(a.ratchet.decryptOwn(m7) === 'my own message', 'alice decrypts her own sent msg via decryptOwn');
  }

  console.log('=== Test 2: BUG simulation (initiator WITH opk, responder WITHOUT opk) ===');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const opk = x25519.keygen();
    const bundle: PreKeyBundle = signedBundle(bob, {
      preKeyPub: bufToBase64(x25519.getPublicKey(opk.secretKey)),
      preKeyId: 'opk-1',
    });
    const a = buildInitiator(alice, bundle);
    // Responder CANNOT get the OPK private (server deleted it) -> null
    const b = buildResponder(bob, null, a.bootstrap);

    const m1 = a.ratchet.encrypt('hello from alice');
    let threw = false;
    try {
      b.decrypt(m1);
    } catch {
      threw = true;
    }
    assert(threw, 'bob FAILS to decrypt alice msg when OPK private is missing (reproduces invalid tag)');

    // And the reverse direction stays unusable too: a failed decrypt used to
    // half-initialize bob's ratchet (leaking mutated state) which let him send
    // messages neither side could read. Transactional decrypt keeps his state
    // pristine, so he cannot send until a session is actually established.
    let sendThrew = false;
    try {
      b.encrypt('hi from bob');
    } catch {
      sendThrew = true;
    }
    assert(sendThrew, 'bob cannot send on an un-established (failed X3DH) session');
  }

  console.log('=== Test 3: both WITHOUT opk (no OPKs at all) => match ===');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const bundle: PreKeyBundle = signedBundle(bob);
    const a = buildInitiator(alice, bundle);
    const b = buildResponder(bob, null, a.bootstrap);
    const m1 = a.ratchet.encrypt('hello');
    assert(b.decrypt(m1) === 'hello', 'both without opk => bob decrypts');
    const m2 = b.encrypt('hi');
    assert(a.ratchet.decrypt(m2) === 'hi', 'both without opk => alice decrypts');
  }

  console.log('');
  if (failures === 0) {
    console.log('ALL TESTS PASSED');
  } else {
    console.error(`${failures} TEST(S) FAILED`);
    process.exit(1);
  }
}

run();
