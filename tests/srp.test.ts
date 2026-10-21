import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clientStep1,
  clientStep2,
  computeVerifier,
  generateSalt,
  serverStep1,
  serverStep2,
  verifyServerProof,
} from '../src/lib/srp.ts';

async function runHandshake(password: string, wrongPassword?: string) {
  const salt = generateSalt();
  const v = await computeVerifier(password, salt);
  const { A, a } = await clientStep1(password, salt);
  const { B, b } = await serverStep1(salt, v);
  const pw = wrongPassword ?? password;
  const finish = await clientStep2(pw, salt, a, B);
  const server = await serverStep2(A, B, b, v, finish.M1);
  return { finish, server };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

test('SRP verifier is deterministic', async () => {
  const salt = generateSalt();
  const v1 = await computeVerifier('hunter2', salt);
  const v2 = await computeVerifier('hunter2', salt);
  assert.ok(bytesEqual(v1, v2));
});

test('SRP full handshake derives matching K and valid server proof', async () => {
  const { finish, server } = await runHandshake('correct horse battery staple');
  assert.ok(server, 'server rejected valid M1');
  assert.ok(bytesEqual(finish.K, server!.K), 'K mismatch between client and server');
  const ok = await verifyServerProof(finish.A, finish.M1, finish.K, server!.M2);
  assert.ok(ok, 'server proof invalid');
});

test('SRP wrong password is rejected', async () => {
  const { server } = await runHandshake('real-password', 'wrong-password');
  assert.equal(server, null, 'server accepted M1 from wrong password');
});

test('SRP rejects A = 0 (A % N == 0)', async () => {
  const salt = generateSalt();
  const v = await computeVerifier('pw', salt);
  const { B, b } = await serverStep1(salt, v);
  const zeroA = new Uint8Array(256);
  const r = await serverStep2(zeroA, B, b, v, new Uint8Array(32));
  assert.equal(r, null, 'server accepted A=0');
});
