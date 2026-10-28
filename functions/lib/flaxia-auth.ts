const AUTH_ORIGIN = 'https://auth.flaxia.app';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type AuthFetcher = Pick<Fetcher, 'fetch'>;
type AuthEnv = { AUTH_SERVICE?: AuthFetcher; AUTH_AUTHORITY_MODE?: string };

export function authIsAuthoritative(env: AuthEnv): boolean {
  return env.AUTH_AUTHORITY_MODE === 'flaxia-auth';
}

export async function credentialStamp(
  db: D1Database,
  userId: string,
): Promise<{ stamp: string; legacy: boolean } | null> {
  const user = await db
    .prepare(
      'SELECT password_hash, srp_salt, srp_verifier, srp_group, srp_kdf FROM users WHERE id = ? AND frozen_at IS NULL',
    )
    .bind(userId)
    .first<{
      srp_salt: string | null;
      srp_verifier: string | null;
      srp_group: string | null;
      srp_kdf: string | null;
      password_hash: string;
    }>();
  if (!user) return null;
  const legacy = user.srp_salt === null && user.srp_verifier === null && !!user.password_hash;
  if (!legacy && (!user.srp_salt || !user.srp_verifier || !user.srp_group)) return null;
  const raw = legacy
    ? JSON.stringify(['legacy', user.password_hash])
    : JSON.stringify([user.srp_salt, user.srp_verifier, user.srp_group, user.srp_kdf ?? 'sha256-v1']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  const stamp = btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return { stamp, legacy };
}

async function postAuth(env: AuthEnv, path: string, body: object): Promise<Response> {
  if (!env.AUTH_SERVICE) throw new Error('Auth service binding unavailable');
  const request = new Request(`${AUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return env.AUTH_SERVICE.fetch(request);
}

export async function revokeAuthGrant(env: AuthEnv, grant: string): Promise<boolean> {
  if (!TOKEN.test(grant)) return false;
  try {
    const response = await postAuth(env, '/api/flaxia/revoke', { grant });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sessionGrant(db: D1Database, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare('SELECT grant_token FROM flaxia_auth_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<{ grant_token: string }>();
  return row?.grant_token ?? null;
}

export async function startAuthReauth(
  env: AuthEnv,
  grant: string,
  userId: string,
): Promise<{ challenge_id: string; salt: string; B: string; srp_kdf: string } | null> {
  try {
    const response = await postAuth(env, '/api/flaxia/reauth/start', { grant, user_id: userId });
    if (!response.ok) return null;
    const body = (await response.json()) as { challenge_id?: unknown; salt?: unknown; B?: unknown; srp_kdf?: unknown };
    if (
      typeof body.challenge_id !== 'string' ||
      typeof body.salt !== 'string' ||
      typeof body.B !== 'string' ||
      typeof body.srp_kdf !== 'string'
    )
      return null;
    return { challenge_id: body.challenge_id, salt: body.salt, B: body.B, srp_kdf: body.srp_kdf };
  } catch {
    return null;
  }
}

export async function verifyAuthReauth(
  env: AuthEnv,
  grant: string,
  userId: string,
  proof: { challenge_id: string; A: string; M1: string },
): Promise<boolean> {
  try {
    const response = await postAuth(env, '/api/flaxia/reauth/verify', { grant, user_id: userId, ...proof });
    if (!response.ok) return false;
    const body = (await response.json()) as { valid?: unknown };
    return body.valid === true;
  } catch {
    return false;
  }
}

export async function exchangeAuthCode(
  env: AuthEnv,
  code: string,
  verifier: string,
): Promise<{ user_id: string; grant: string; credential_stamp: string; legacy_stamp: string | null } | null> {
  if (!TOKEN.test(code) || !TOKEN.test(verifier)) return null;
  try {
    const response = await postAuth(env, '/api/flaxia/exchange', { code, verifier });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      user_id?: unknown;
      grant?: unknown;
      credential_stamp?: unknown;
      legacy_stamp?: unknown;
    };
    if (
      typeof body.user_id !== 'string' ||
      body.user_id.length < 1 ||
      body.user_id.length > 128 ||
      typeof body.grant !== 'string' ||
      !TOKEN.test(body.grant) ||
      typeof body.credential_stamp !== 'string' ||
      !TOKEN.test(body.credential_stamp) ||
      (body.legacy_stamp !== null && (typeof body.legacy_stamp !== 'string' || !TOKEN.test(body.legacy_stamp)))
    )
      return null;
    return {
      user_id: body.user_id,
      grant: body.grant,
      credential_stamp: body.credential_stamp,
      legacy_stamp: body.legacy_stamp as string | null,
    };
  } catch {
    return null;
  }
}

// Existing Flaxia sessions remain valid. Sessions issued from Auth are checked
// against the Auth session on every request so revocation takes effect.
export async function isSessionAuthorized(env: Env, sessionId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT grant_token, auth_stamp, source_stamp FROM flaxia_auth_sessions WHERE session_id = ?',
  )
    .bind(sessionId)
    .first<{ grant_token: string; auth_stamp: string; source_stamp: string }>();
  if (!row) return !authIsAuthoritative(env as AuthEnv);
  try {
    const response = await postAuth(env as AuthEnv, '/api/flaxia/introspect', { grant: row.grant_token });
    if (!response.ok) return false;
    const body = (await response.json()) as { user_id?: unknown; credential_stamp?: unknown };
    const localStamp = await credentialStamp(env.DB, userId);
    return (
      localStamp !== null &&
      localStamp.stamp === row.source_stamp &&
      body.user_id === userId &&
      body.credential_stamp === row.auth_stamp
    );
  } catch {
    return false;
  }
}
