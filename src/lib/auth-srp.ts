// Client-side SRP-6a auth helpers. The account password never leaves the
// browser in plaintext: registration computes the verifier locally, and login
// proves knowledge of the password via the SRP handshake.

import { clientStep1, clientStep2, computeVerifier, generateSalt, verifyServerProof } from './srp.ts';

function b64(b: Uint8Array): string {
  let binary = '';
  for (const x of b) binary += String.fromCharCode(x);
  return btoa(binary);
}

function unb64(s: string): Uint8Array {
  const binary = atob(s);
  const b = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) b[i] = binary.charCodeAt(i);
  return b;
}

// The SRP salt is not secret; persist it so a tab that did not perform the
// login handshake can still reuse the same salt (e.g. a password re-prompt).
const SRP_SALT_KEY = 'flaxia_srp_salt';

export function storeSrpSalt(salt: Uint8Array): void {
  try {
    localStorage.setItem(SRP_SALT_KEY, b64(salt));
  } catch {
    /* ignore */
  }
}

export function getStoredSrpSalt(): Uint8Array | null {
  try {
    const s = localStorage.getItem(SRP_SALT_KEY);
    return s ? unb64(s) : null;
  } catch {
    return null;
  }
}

// Register a new account via SRP.
export async function registerWithSrp(
  email: string,
  username: string,
  displayName: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt);
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      email,
      username,
      display_name: displayName,
      srp_salt: b64(salt),
      srp_verifier: b64(verifier),
      srp_group: '2048',
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error };
  }
  storeSrpSalt(salt);
  return { ok: true };
}

// Log in via SRP. Legacy (non-SRP) accounts transparently fall back to the
// plaintext endpoint, then upgrade to SRP on first login.
export async function loginWithSrp(email: string, password: string): Promise<boolean> {
  const start = await fetch('/api/auth/login/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  if (!start.ok) return false;
  const s = (await start.json()) as { srp: boolean; challenge_id?: string; salt?: string; B?: string };
  if (!s.srp) {
    const legacy = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!legacy.ok) return false;
    await upgradeSrp(password);
    return true;
  }

  const salt = unb64(s.salt!);
  const B = unb64(s.B!);
  const { A, a } = await clientStep1(password, salt);
  const finish = await clientStep2(password, salt, a, B);
  const verify = await fetch('/api/auth/login/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, challenge_id: s.challenge_id, A: b64(A), M1: b64(finish.M1) }),
  });
  if (!verify.ok) return false;
  const data = (await verify.json()) as { M2?: string };
  const ok = data.M2 ? await verifyServerProof(finish.A, finish.M1, finish.K, unb64(data.M2)) : false;
  if (!ok) return false;

  storeSrpSalt(salt);
  return true;
}

// Upgrade a legacy account to SRP (compute verifier locally).
async function upgradeSrp(password: string): Promise<void> {
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt);
  await fetch('/api/auth/upgrade-srp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      srp_salt: b64(salt),
      srp_verifier: b64(verifier),
      srp_group: '2048',
    }),
  });
  storeSrpSalt(salt);
}

// Verify the current user's password via SRP without creating a session or
// modifying any state. Returns true if the password is correct, false otherwise.
export async function verifyCurrentPassword(password: string): Promise<boolean> {
  try {
    const reauth = await fetch('/api/auth/reauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!reauth.ok) return false;
    const r = (await reauth.json()) as { challenge_id: string; salt: string; B: string };
    const { A, a } = await clientStep1(password, unb64(r.salt));
    const finish = await clientStep2(password, unb64(r.salt), a, unb64(r.B));
    const res = await fetch('/api/auth/reauth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        challenge_id: r.challenge_id,
        A: b64(A),
        M1: b64(finish.M1),
      }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { valid?: boolean };
    return !!data.valid;
  } catch {
    return false;
  }
}
