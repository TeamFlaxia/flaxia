import { clientStep1, clientStep2, isSupportedSrpKdf, verifyServerProof } from './srp.ts';

const AUTH_ORIGIN = 'https://auth.flaxia.app';
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const base64url = (bytes: Uint8Array): string =>
  encode(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

type LoginResult = boolean | { frozen: true; username: string };

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
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const authorize = await post(AUTH_ORIGIN, '/api/auth/flaxia/authorize', { challenge });
  if (!authorize.ok) return false;
  const response = (await authorize.json()) as { code?: unknown };
  if (typeof response.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.code)) return false;
  return (await post('', '/api/auth/flaxia/exchange', { code: response.code, verifier })).ok;
}
