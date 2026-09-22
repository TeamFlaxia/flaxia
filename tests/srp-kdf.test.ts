// KDF versioning for the SRP private value x.
//
// x = KDF(password, salt) is committed to by the stored verifier v = g^x, so
// the cost of a database attacker's dictionary attack is set entirely here.
// v1 was a single SHA-256 (one hash per guess); v2 is PBKDF2-SHA256 with
// 600,000 iterations. Both must keep working: v1 because every pre-existing
// account is labelled with it, v2 because everything new is written with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clientStep1,
  clientStep2,
  computeVerifier,
  DEFAULT_SRP_KDF,
  generateSalt,
  isSupportedSrpKdf,
  SRP_KDF_V1,
  SRP_KDF_V2,
  serverStep1,
  serverStep2,
  verifyServerProof,
} from '../src/lib/srp.ts';

async function handshake(password: string, kdf: Parameters<typeof computeVerifier>[2]) {
  const salt = generateSalt();
  const v = await computeVerifier(password, salt, kdf);
  const { A, a } = await clientStep1(password, salt);
  const { B, b } = await serverStep1(salt, v);
  const finish = await clientStep2(password, salt, a, B, kdf);
  const server = await serverStep2(A, B, b, v, finish.M1);
  return { finish, server };
}

test('v2 handshake succeeds and the server proof verifies', async () => {
  const { finish, server } = await handshake('correct horse battery staple', SRP_KDF_V2);
  assert.ok(server, 'server rejected a valid v2 proof');
  const ok = await verifyServerProof(finish.A, finish.M1, finish.K, server!.M2);
  assert.ok(ok, 'server proof did not verify');
});

test('v1 handshake still succeeds (pre-existing accounts)', async () => {
  const { finish, server } = await handshake('correct horse battery staple', SRP_KDF_V1);
  assert.ok(server, 'server rejected a valid v1 proof');
  const ok = await verifyServerProof(finish.A, finish.M1, finish.K, server!.M2);
  assert.ok(ok, 'server proof did not verify');
});

test('v2 is the default KDF for new verifiers', () => {
  assert.equal(DEFAULT_SRP_KDF, SRP_KDF_V2);
});

test('the same password yields a different verifier under v2 than v1', async () => {
  // This is what makes the migration meaningful: v2 must not be v1 wearing a
  // label. Same password, same salt, different v.
  const salt = generateSalt();
  const v1 = await computeVerifier('shared-password', salt, SRP_KDF_V1);
  const v2 = await computeVerifier('shared-password', salt, SRP_KDF_V2);
  assert.notDeepEqual(v1, v2);
});

test('a client using the wrong KDF version is rejected', async () => {
  // Verifier built with v1, client proves with v2 → different x → different M1.
  const salt = generateSalt();
  const v = await computeVerifier('pw', salt, SRP_KDF_V1);
  const { A, a } = await clientStep1('pw', salt);
  const { B, b } = await serverStep1(salt, v);
  const finish = await clientStep2('pw', salt, a, B, SRP_KDF_V2);
  const server = await serverStep2(A, B, b, v, finish.M1);
  assert.equal(server, null, 'server accepted a proof derived with the wrong KDF');
});

test('v2 verification is deterministic for a fixed password and salt', async () => {
  const salt = generateSalt();
  const a = await computeVerifier('deterministic', salt, SRP_KDF_V2);
  const b = await computeVerifier('deterministic', salt, SRP_KDF_V2);
  assert.deepEqual(a, b);
});

test('a wrong password is rejected under v2', async () => {
  const salt = generateSalt();
  const v = await computeVerifier('right-password', salt, SRP_KDF_V2);
  const { A, a } = await clientStep1('wrong-password', salt);
  const { B, b } = await serverStep1(salt, v);
  const finish = await clientStep2('wrong-password', salt, a, B, SRP_KDF_V2);
  const server = await serverStep2(A, B, b, v, finish.M1);
  assert.equal(server, null);
});

test('the KDF id is an allowlist, not a passthrough', () => {
  assert.ok(isSupportedSrpKdf(SRP_KDF_V1));
  assert.ok(isSupportedSrpKdf(SRP_KDF_V2));
  assert.ok(!isSupportedSrpKdf('pbkdf2-1-v2'), 'a cheap iteration count must not be accepted');
  assert.ok(!isSupportedSrpKdf('sha256-v0'));
  assert.ok(!isSupportedSrpKdf(undefined));
  assert.ok(!isSupportedSrpKdf(null));
  assert.ok(!isSupportedSrpKdf(600000));
});
