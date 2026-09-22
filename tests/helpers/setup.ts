// Integration test helpers.
//
// Registration and login go through SRP, exactly like the real SPA: the test
// process derives the verifier locally and never sends the password. This is
// what the production endpoint requires (POST /api/auth/register is SRP-only),
// so a plaintext helper would simply get 400s.
import {
  clientStep1,
  clientStep2,
  computeVerifier,
  DEFAULT_SRP_KDF,
  generateSalt,
  isSupportedSrpKdf,
  type SrpKdfId,
  verifyServerProof,
} from '../../src/lib/srp.ts';

export const BASE_URL = 'http://localhost:8788';

export async function resetDb(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
  if (!res.ok) throw new Error('DB reset failed');
}

function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export async function registerUser(data: {
  email: string;
  password: string;
  username: string;
  display_name: string;
}): Promise<Response> {
  const salt = generateSalt();
  const verifier = await computeVerifier(data.password, salt, DEFAULT_SRP_KDF);
  return fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: data.email,
      username: data.username,
      display_name: data.display_name,
      srp_salt: b64(salt),
      srp_verifier: b64(verifier),
      srp_group: '2048',
      srp_kdf: DEFAULT_SRP_KDF,
    }),
  });
}

// Run the SRP handshake for an account whose verifier was derived with `kdf`.
export async function srpLogin(
  email: string,
  password: string,
  kdf: SrpKdfId = DEFAULT_SRP_KDF,
): Promise<{ res: Response; cookie: string; verified: boolean }> {
  const start = await fetch(`${BASE_URL}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const s = (await start.json()) as {
    srp: boolean;
    challenge_id?: string;
    salt?: string;
    B?: string;
    srp_kdf?: string;
  };
  if (!s.srp || !s.challenge_id || !s.salt || !s.B) {
    throw new Error(`SRP start did not return a handshake for ${email}`);
  }

  const salt = unb64(s.salt);
  const usedKdf = isSupportedSrpKdf(s.srp_kdf) ? s.srp_kdf : kdf;
  const { A, a } = await clientStep1(password, salt);
  const finish = await clientStep2(password, salt, a, unb64(s.B), usedKdf);

  const res = await fetch(`${BASE_URL}/api/auth/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, challenge_id: s.challenge_id, A: b64(A), M1: b64(finish.M1) }),
  });
  const data = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { M2?: string };
  const verified = data.M2 ? await verifyServerProof(finish.A, finish.M1, finish.K, unb64(data.M2)) : false;
  return { res, cookie: res.headers.get('set-cookie') ?? '', verified };
}

// SRP login with a fallback to the deprecated plaintext endpoint, which is how
// accounts created before SRP still sign in. Only tests that deliberately seed
// a legacy account ever take the fallback.
export async function loginUser(email: string, password: string): Promise<{ res: Response; cookie: string }> {
  const start = await fetch(`${BASE_URL}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const s = (await start.json()) as { srp: boolean };
  if (!s.srp) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return { res, cookie: res.headers.get('set-cookie') ?? '' };
  }
  const { res, cookie } = await srpLogin(email, password);
  return { res, cookie };
}

// Prove knowledge of the current password to the server without sending it
// (used by the password/email change endpoints).
export async function createSrpProof(
  cookie: string,
  password: string,
): Promise<{ challenge_id: string; A: string; M1: string } | null> {
  const reauth = await fetch(`${BASE_URL}/api/auth/reauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  });
  if (!reauth.ok) return null;
  const r = (await reauth.json()) as { challenge_id: string; salt: string; B: string; srp_kdf?: string };
  const salt = unb64(r.salt);
  const kdf = isSupportedSrpKdf(r.srp_kdf) ? r.srp_kdf : DEFAULT_SRP_KDF;
  const { A, a } = await clientStep1(password, salt);
  const finish = await clientStep2(password, salt, a, unb64(r.B), kdf);
  return { challenge_id: r.challenge_id, A: b64(A), M1: b64(finish.M1) };
}

// A registration/upgrade payload: a locally derived verifier for `password`.
export async function srpVerifierPayload(password: string): Promise<{
  srp_salt: string;
  srp_verifier: string;
  srp_group: string;
  srp_kdf: string;
}> {
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt, DEFAULT_SRP_KDF);
  return {
    srp_salt: b64(salt),
    srp_verifier: b64(verifier),
    srp_group: '2048',
    srp_kdf: DEFAULT_SRP_KDF,
  };
}

// Create an account that predates SRP so the deprecated plaintext /login
// endpoint stays covered until it is deleted.
export async function seedLegacyUser(email: string, password: string, username: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/test/seed-legacy-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username, display_name: username }),
  });
}

// Learnable usernames must be 1-20 chars of [a-zA-Z0-9_]; test suffixes may
// contain punctuation or be long, so sanitize and append a stable hash when
// truncation alone would collide.
function testUsername(suffix: string): string {
  const sanitized = `testuser${suffix}`.replace(/[^a-zA-Z0-9_]/g, '');
  if (sanitized.length <= 20) return sanitized;
  let hash = 5381;
  for (let i = 0; i < suffix.length; i++) hash = ((hash << 5) + hash + suffix.charCodeAt(i)) >>> 0;
  return `${sanitized.slice(0, 12)}${hash.toString(36).slice(0, 7)}`;
}

export async function seedUserAndLogin(suffix = '1') {
  const username = testUsername(suffix);
  await registerUser({
    email: `user${suffix}@test.com`,
    password: 'password123',
    username,
    display_name: `Test User ${suffix}`,
  });
  const login = await loginUser(`user${suffix}@test.com`, 'password123');
  return {
    ...login,
    username,
    email: `user${suffix}@test.com`,
    display_name: `Test User ${suffix}`,
    password: 'password123',
  };
}
