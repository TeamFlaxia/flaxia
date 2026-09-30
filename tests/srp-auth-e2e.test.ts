import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  clientStep1,
  clientStep2,
  computeVerifier,
  DEFAULT_SRP_KDF,
  generateSalt,
  verifyServerProof,
} from '../src/lib/srp.ts';
import { BASE_URL, resetDb, seedLegacyUser } from './helpers/setup.ts';

function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

async function registerSrp(email: string, username: string, password: string): Promise<Response> {
  const salt = generateSalt();
  const v = await computeVerifier(password, salt, DEFAULT_SRP_KDF);
  return fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      username,
      display_name: username,
      srp_salt: b64(salt),
      srp_verifier: b64(v),
      srp_group: '2048',
      srp_kdf: DEFAULT_SRP_KDF,
    }),
  });
}

async function srpLogin(email: string, password: string): Promise<{ status: number; ok: boolean; cookie: string }> {
  const start = await fetch(`${BASE_URL}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const s = (await start.json()) as { srp: boolean; challenge_id?: string; salt?: string; B?: string; srp_kdf?: string };
  if (!s.srp || !s.challenge_id || !s.salt || !s.B) throw new Error('SRP start did not return handshake');

  const salt = unb64(s.salt);
  const B = unb64(s.B);
  const { A, a } = await clientStep1(password, salt);
  const kdf = s.srp_kdf === 'sha256-v1' || s.srp_kdf === DEFAULT_SRP_KDF ? s.srp_kdf : DEFAULT_SRP_KDF;
  const finish = await clientStep2(password, salt, a, B, kdf);

  const verify = await fetch(`${BASE_URL}/api/auth/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      challenge_id: s.challenge_id,
      A: b64(A),
      M1: b64(finish.M1),
    }),
  });
  const data = (await verify.json()) as { M2?: string };
  const ok = data.M2 ? await verifyServerProof(finish.A, finish.M1, finish.K, unb64(data.M2)) : false;
  return { status: verify.status, ok, cookie: verify.headers.get('set-cookie') ?? '' };
}

describe('SRP-6a authentication (server never sees plaintext password)', () => {
  beforeEach(resetDb);

  it('registers and logs in via SRP, validating the server proof', async () => {
    const reg = await registerSrp('srp@example.com', 'srpuser', 'correct horse battery staple');
    assert.equal(reg.status, 201);

    const login = await srpLogin('srp@example.com', 'correct horse battery staple');
    assert.equal(login.status, 200);
    assert.ok(login.ok, 'server proof M2 should verify');
    assert.ok(login.cookie.includes('session='), 'session cookie should be set');
  });

  it('rejects an SRP login with the wrong password', async () => {
    await registerSrp('srp2@example.com', 'srpuser2', 'real-password');
    const start = await fetch(`${BASE_URL}/api/auth/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'srp2@example.com' }),
    });
    const s = (await start.json()) as { challenge_id: string; salt: string; B: string };
    const salt = unb64(s.salt);
    const B = unb64(s.B);
    const { A, a } = await clientStep1('wrong-password', salt);
    const finish = await clientStep2('wrong-password', salt, a, B);
    const verify = await fetch(`${BASE_URL}/api/auth/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'srp2@example.com', challenge_id: s.challenge_id, A: b64(A), M1: b64(finish.M1) }),
    });
    assert.equal(verify.status, 401);
  });

  it('migrates a v1 verifier only with a current-password proof', async () => {
    const oldSalt = generateSalt();
    const oldVerifier = await computeVerifier('v1-password-123', oldSalt, 'sha256-v1');
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'v1@example.com',
        username: 'v1user',
        display_name: 'V1 User',
        srp_salt: b64(oldSalt),
        srp_verifier: b64(oldVerifier),
        srp_group: '2048',
        srp_kdf: 'sha256-v1',
      }),
    });
    const login = await srpLogin('v1@example.com', 'v1-password-123');
    assert.equal(login.status, 200);

    const newSalt = generateSalt();
    const newVerifier = await computeVerifier('v1-password-123', newSalt, DEFAULT_SRP_KDF);
    const noProof = await fetch(`${BASE_URL}/api/auth/upgrade-srp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: login.cookie },
      body: JSON.stringify({ srp_salt: b64(newSalt), srp_verifier: b64(newVerifier), srp_group: '2048', srp_kdf: DEFAULT_SRP_KDF }),
    });
    assert.equal(noProof.status, 400);

    const reauth = await fetch(`${BASE_URL}/api/auth/reauth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: login.cookie },
    });
    const challenge = (await reauth.json()) as { challenge_id: string; salt: string; B: string };
    const salt = unb64(challenge.salt);
    const first = await clientStep1('v1-password-123', salt);
    const finish = await clientStep2('v1-password-123', salt, first.a, unb64(challenge.B), 'sha256-v1');
    const upgraded = await fetch(`${BASE_URL}/api/auth/upgrade-srp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: login.cookie },
      body: JSON.stringify({
        srp_salt: b64(newSalt),
        srp_verifier: b64(newVerifier),
        srp_group: '2048',
        srp_kdf: DEFAULT_SRP_KDF,
        current_srp: { challenge_id: challenge.challenge_id, A: b64(first.A), M1: b64(finish.M1) },
      }),
    });
    assert.equal(upgraded.status, 200);
  });

  it('legacy /login/start signals fallback for non-SRP accounts', async () => {
    // Only a pre-SRP account can lack a verifier now: registration is SRP-only.
    await seedLegacyUser('noversrp@test.com', 'legacy-password-1', 'noversrp');
    const start = await fetch(`${BASE_URL}/api/auth/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userlegacysrp@test.com' }),
    });
    const data = (await start.json()) as { srp: boolean };
    assert.equal(data.srp, false);

    // ...and the deprecated plaintext endpoint still admits it.
    const legacy = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noversrp@test.com', password: 'legacy-password-1' }),
    });
    assert.equal(legacy.status, 200);
  });
});
