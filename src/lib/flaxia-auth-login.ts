import { createSrpProof } from './auth-srp.ts';
import {
  clientStep1,
  clientStep2,
  computeVerifier,
  DEFAULT_SRP_KDF,
  generateSalt,
  isSupportedSrpKdf,
  verifyServerProof,
} from './srp.ts';

const AUTH_ORIGIN = 'https://auth.flaxia.app';
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const base64url = (bytes: Uint8Array): string =>
  encode(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

type LoginResult = boolean | { frozen: true; username: string };

export async function loginWithFlaxiaAuthRecovery(username: string, recoveryCode: string): Promise<boolean> {
  const post = (path: string, body: object) =>
    fetch(`${AUTH_ORIGIN}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const start = await post('/api/auth/recovery/start', { username });
  if (!start.ok) return false;
  const hs = (await start.json()) as { challenge_id?: unknown; salt?: unknown; B?: unknown; srp_kdf?: unknown };
  if (
    typeof hs.challenge_id !== 'string' ||
    typeof hs.salt !== 'string' ||
    typeof hs.B !== 'string' ||
    !isSupportedSrpKdf(hs.srp_kdf)
  )
    return false;
  const salt = decode(hs.salt);
  const first = await clientStep1(recoveryCode, salt);
  const proof = await clientStep2(recoveryCode, salt, first.a, decode(hs.B), hs.srp_kdf);
  const response = await post('/api/auth/recovery/verify', {
    challenge_id: hs.challenge_id,
    A: encode(proof.A),
    M1: encode(proof.M1),
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { M2?: unknown };
  if (typeof result.M2 !== 'string' || !(await verifyServerProof(proof.A, proof.M1, proof.K, decode(result.M2))))
    return false;
  const exchanged = await exchangeSignedInAuth();
  if (exchanged && typeof sessionStorage !== 'undefined') sessionStorage.setItem('flaxia.recovery-login', '1');
  return exchanged;
}

export async function flaxiaAuthIsAuthoritative(): Promise<boolean> {
  const response = await fetch('/api/auth/mode', { cache: 'no-store' });
  if (!response.ok) throw new Error('Authentication configuration unavailable');
  return ((await response.json()) as { authority?: unknown }).authority === 'flaxia-auth';
}

async function exchangeSignedInAuth(): Promise<boolean> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const authorize = await fetch(`${AUTH_ORIGIN}/api/auth/flaxia/authorize`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge }),
  });
  if (!authorize.ok) return false;
  const response = (await authorize.json()) as { code?: unknown };
  if (typeof response.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.code)) return false;
  return (
    await fetch('/api/auth/flaxia/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: response.code, verifier }),
    })
  ).ok;
}

export async function enrollRecoveryCode(password: string, recoveryCode: string): Promise<boolean> {
  const recoverySalt = generateSalt();
  const recoveryVerifier = await computeVerifier(recoveryCode, recoverySalt, DEFAULT_SRP_KDF);
  const currentSrp = await createSrpProof(password);
  if (!currentSrp) return false;
  const response = await fetch('/api/auth/recovery/enroll', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      salt: encode(recoverySalt),
      verifier: encode(recoveryVerifier),
      kdf: DEFAULT_SRP_KDF,
      current_srp: currentSrp,
    }),
  });
  return response.ok;
}

export async function registerWithFlaxiaAuth(
  email: string,
  username: string,
  displayName: string,
  password: string,
  recoveryCode: string,
): Promise<{ ok: boolean; error?: string }> {
  const salt = generateSalt();
  const verifier = await computeVerifier(password, salt, DEFAULT_SRP_KDF);
  const response = await fetch(`${AUTH_ORIGIN}/api/auth/register`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      username,
      display_name: displayName,
      srp_salt: encode(salt),
      srp_verifier: encode(verifier),
      srp_group: '2048',
      srp_kdf: DEFAULT_SRP_KDF,
    }),
  });
  if (!response.ok)
    return { ok: false, error: ((await response.json().catch(() => ({}))) as { error?: string }).error };
  if (!(await exchangeSignedInAuth())) return { ok: false, error: 'recovery_setup_incomplete' };
  const enrolled = await enrollRecoveryCode(password, recoveryCode);
  if (enrolled && typeof sessionStorage !== 'undefined') sessionStorage.removeItem('flaxia.recovery-login');
  return enrolled ? { ok: true } : { ok: false, error: 'recovery_setup_incomplete' };
}

export async function loginWithFlaxiaAuth(username: string, password: string): Promise<LoginResult> {
  const post = (base: string, path: string, body: object) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const start = await post(AUTH_ORIGIN, '/api/auth/login/start', { username });
  if (!start.ok) return false;
  const handshake = (await start.json()) as {
    srp?: boolean;
    challenge_id?: string;
    salt?: string;
    B?: string;
    srp_kdf?: unknown;
  };
  if (handshake.srp === false) {
    const legacy = await post(AUTH_ORIGIN, '/api/auth/login/legacy', { username, password });
    const data = (await legacy.json().catch(() => ({}))) as { error?: string; username?: string };
    if (legacy.status === 403 && data.error === 'account_frozen' && data.username)
      return { frozen: true, username: data.username };
    if (!legacy.ok) return false;
  } else {
    if (
      !handshake.srp ||
      !handshake.challenge_id ||
      !handshake.salt ||
      !handshake.B ||
      !isSupportedSrpKdf(handshake.srp_kdf)
    )
      return false;
    const salt = decode(handshake.salt);
    const { a } = await clientStep1(password, salt);
    const proof = await clientStep2(password, salt, a, decode(handshake.B), handshake.srp_kdf);
    const verify = await post(AUTH_ORIGIN, '/api/auth/login/verify', {
      challenge_id: handshake.challenge_id,
      A: encode(proof.A),
      M1: encode(proof.M1),
    });
    const result = (await verify.json().catch(() => ({}))) as { M2?: string; error?: string; username?: string };
    if (!result.M2 || !(await verifyServerProof(proof.A, proof.M1, proof.K, decode(result.M2)))) return false;
    if (verify.status === 403 && result.error === 'account_frozen' && result.username)
      return { frozen: true, username: result.username };
    if (!verify.ok) return false;
  }
  const exchanged = await exchangeSignedInAuth();
  if (exchanged && typeof sessionStorage !== 'undefined') sessionStorage.removeItem('flaxia.recovery-login');
  return exchanged;
}
