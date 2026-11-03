const AUTH_ORIGIN = 'https://auth.flaxia.app';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type AuthFetcher = Pick<Fetcher, 'fetch'>;
type AuthEnv = { AUTH_SERVICE?: AuthFetcher; AUTH_AUTHORITY_MODE?: string };
export type CredentialFields = {
  srp_salt: string | null;
  srp_verifier: string | null;
  srp_group: string | null;
  srp_kdf: string | null;
  password_hash: string | null;
};

export function authIsAuthoritative(env: AuthEnv): boolean {
  return env.AUTH_AUTHORITY_MODE === 'flaxia-auth';
}

// Once identity linking has been verified and no transition is in flight,
// erase every locally held authentication secret and session atomically.
export async function purgeLinkedLocalCredentials(db: D1Database, userId: string): Promise<boolean> {
  const assertion = () =>
    db.prepare(
      'INSERT INTO flaxia_auth_transition_assertions (valid) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE NULL END)',
    );
  try {
    const clean = await db
      .prepare(`SELECT 1 FROM users u JOIN flaxia_auth_links l ON l.user_id = u.id
      WHERE u.id = ? AND u.frozen_at IS NULL AND u.password_hash = '' AND u.srp_salt IS NULL AND u.srp_verifier IS NULL AND u.srp_group IS NULL AND u.srp_kdf IS NULL
      AND NOT EXISTS (SELECT 1 FROM flaxia_auth_provisioning p WHERE p.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM srp_handshakes h WHERE h.user_id = u.id)`)
      .bind(userId)
      .first();
    if (clean) return true;
    await db.batch([
      db
        .prepare(`INSERT INTO flaxia_auth_purge_in_progress (user_id)
        SELECT u.id FROM users u JOIN flaxia_auth_links l ON l.user_id = u.id
        WHERE u.id = ? AND u.frozen_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs j WHERE j.user_id = u.id AND j.state NOT IN ('committed', 'cancelled'))
          AND NOT EXISTS (SELECT 1 FROM flaxia_direct_vault_changes j WHERE j.user_id = u.id AND j.state NOT IN ('committed', 'cancelled'))
          AND NOT EXISTS (SELECT 1 FROM flaxia_auth_deletion_jobs j WHERE j.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM flaxia_direct_deletion_jobs j WHERE j.user_id = u.id)`)
        .bind(userId),
      assertion(),
      db.prepare('DELETE FROM flaxia_auth_transition_assertions'),
      db.prepare('DELETE FROM flaxia_auth_provisioning WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM srp_handshakes WHERE user_id = ?').bind(userId),
      db
        .prepare(
          "UPDATE users SET password_hash = '', srp_salt = NULL, srp_verifier = NULL, srp_group = NULL, srp_kdf = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM flaxia_auth_purge_in_progress WHERE user_id = users.id)",
        )
        .bind(userId),
      assertion(),
      db.prepare('DELETE FROM flaxia_auth_transition_assertions'),
      db.prepare('DELETE FROM flaxia_auth_purge_in_progress WHERE user_id = ?').bind(userId),
    ]);
    return true;
  } catch {
    return false;
  }
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
    .first<CredentialFields>();
  if (!user) return null;
  return credentialStampFor(user);
}

export async function credentialStampFor(user: CredentialFields): Promise<{ stamp: string; legacy: boolean } | null> {
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

async function postAuth(env: AuthEnv, path: string, body: object, timeout = 3000): Promise<Response> {
  if (!env.AUTH_SERVICE) throw new Error('Auth service binding unavailable');
  const request = new Request(`${AUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  return env.AUTH_SERVICE.fetch(request);
}

/**
 * Proxy one Vault request through Auth. The grant is the only credential: no
 * wrapped key or password material is interpreted here, and nothing is written
 * to Flaxia's D1. Returns null when Auth is unavailable so callers can fail
 * closed instead of silently falling back to the transitional local store.
 */
export async function authVaultRequest(
  env: AuthEnv,
  grant: string,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!TOKEN.test(grant)) return null;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return null;
  if (typeof path !== 'string' || !path.startsWith('/api/vault') || path.length > 128) return null;
  try {
    // Vault payloads reach the item storage ceiling, so the credential
    // path's short deadline is not enough for a cold Auth or a large item.
    const response = await postAuth(
      env,
      '/api/flaxia/vault',
      {
        grant,
        user_id: userId,
        method,
        path,
        ...(body === undefined ? {} : { body }),
      },
      15_000,
    );
    if (response.status >= 500) return null;
    const result = (await response.json()) as Record<string, unknown>;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    return { status: response.status, body: result };
  } catch {
    return null;
  }
}

/**
 * Copy the transitional Flaxia-owned rows into Auth. The body is opaque
 * ciphertext only; Auth validates shapes and refuses to replace an envelope it
 * already owns, which makes retries safe.
 */
export async function authVaultImport(
  env: AuthEnv,
  grant: string,
  userId: string,
  payload: { keys: unknown; devices: unknown[]; items: unknown[] },
): Promise<'imported' | 'reused' | 'conflict' | 'unavailable'> {
  if (!TOKEN.test(grant)) return 'unavailable';
  try {
    const response = await postAuth(env, '/api/flaxia/vault/import', { grant, user_id: userId, ...payload }, 15_000);
    if (response.status === 409) return 'conflict';
    if (!response.ok) return 'unavailable';
    const result = (await response.json()) as { success?: unknown; imported?: unknown };
    if (result.success !== true) return 'unavailable';
    return result.imported === true ? 'imported' : 'reused';
  } catch {
    return 'unavailable';
  }
}

export async function provisionAuthAccount(
  env: AuthEnv,
  account: {
    user_id: string;
    username: string;
    display_name: string;
    srp_salt: string;
    srp_verifier: string;
    srp_group: string;
    srp_kdf: string;
  },
): Promise<'ok' | 'conflict' | 'unavailable'> {
  try {
    const response = await postAuth(env, '/api/flaxia/provision', account);
    if (response.status === 409) return 'conflict';
    if (!response.ok) return 'unavailable';
    const body = (await response.json()) as { success?: unknown };
    return body.success === true ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
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

export async function revokeAuthUserGrants(env: AuthEnv, userId: string): Promise<boolean> {
  try {
    const response = await postAuth(env, '/api/flaxia/revoke-user', { user_id: userId });
    return response.ok;
  } catch {
    return false;
  }
}

// Moderation actions must land at Auth first: deleting only the local profile
// would leave the identity able to create a new profile, and freezing only
// locally would leave the Auth account usable elsewhere.
export async function adminAuthAccount(
  env: AuthEnv,
  action: 'freeze' | 'unfreeze' | 'delete',
  userId: string,
  reason?: string,
): Promise<'ok' | 'not_found' | 'unavailable'> {
  try {
    const response = await postAuth(env, '/api/flaxia/admin/account', {
      user_id: userId,
      action,
      ...(action === 'freeze' ? { reason: reason ?? '' } : {}),
    });
    if (response.status === 404) return 'not_found';
    if (!response.ok) return 'unavailable';
    const body = (await response.json()) as { success?: unknown };
    return body.success === true ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function completeAuthLink(env: AuthEnv, grant: string, userId: string): Promise<boolean> {
  try {
    return (await postAuth(env, '/api/flaxia/link-complete', { grant, user_id: userId })).ok;
  } catch {
    return false;
  }
}

// Resolve an application grant against Auth directly. The grant is an opaque
// bearer capability held in the browser cookie; it is never looked up in the
// Flaxia database. An unavailable or malformed Auth response fails closed.
export async function introspectAuthGrant(
  env: AuthEnv,
  grant: string,
): Promise<{ user_id: string; expires_at: string } | null> {
  if (!TOKEN.test(grant)) return null;
  try {
    const response = await postAuth(env, '/api/flaxia/introspect', { grant });
    if (!response.ok) return null;
    const body = (await response.json()) as { user_id?: unknown; expires_at?: unknown };
    if (
      typeof body.user_id !== 'string' ||
      body.user_id.length < 1 ||
      body.user_id.length > 128 ||
      typeof body.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(body.expires_at)) ||
      Date.parse(body.expires_at) <= Date.now()
    )
      return null;
    return { user_id: body.user_id, expires_at: body.expires_at };
  } catch {
    return null;
  }
}

export async function deleteAuthAccount(
  env: AuthEnv,
  operation: string,
  grant: string,
  userId: string,
  proof: { challenge_id: string; A: string; M1: string },
): Promise<'ok' | 'denied' | 'unavailable'> {
  if (!TOKEN.test(operation) || !TOKEN.test(grant)) return 'denied';
  try {
    const response = await postAuth(env, '/api/flaxia/delete', {
      operation,
      grant,
      user_id: userId,
      current_srp: proof,
    });
    if (response.status === 400 || response.status === 401 || response.status === 409) return 'denied';
    if (!response.ok) return 'unavailable';
    const result = (await response.json()) as { success?: unknown };
    return result.success === true ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function cancelAuthDeletion(
  env: AuthEnv,
  operationHash: string,
  grant: string,
  userId: string,
): Promise<boolean> {
  if (!TOKEN.test(operationHash) || !TOKEN.test(grant)) return false;
  try {
    return (
      await postAuth(env, '/api/flaxia/delete/cancel-hash', { operation_hash: operationHash, grant, user_id: userId })
    ).ok;
  } catch {
    return false;
  }
}

export async function authDeletionCompleted(
  env: AuthEnv,
  operationHash: string,
  userId: string,
): Promise<boolean | null> {
  if (!TOKEN.test(operationHash)) return null;
  try {
    const response = await postAuth(env, '/api/flaxia/delete/status', {
      operation_hash: operationHash,
      user_id: userId,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { deleted?: unknown };
    return typeof body.deleted === 'boolean' ? body.deleted : null;
  } catch {
    return null;
  }
}

type CredentialOperation = { operation: string; grant: string; user_id: string };
export async function authCredentialStatus(
  env: AuthEnv,
  body: CredentialOperation,
): Promise<{ state: 'prepared' | 'committed' | 'cancelled'; target_stamp: string } | 'not_found' | 'unavailable'> {
  if (!TOKEN.test(body.operation) || !TOKEN.test(body.grant)) return 'unavailable';
  try {
    const response = await postAuth(env, '/api/flaxia/credentials/status', body);
    if (response.status === 404) return 'not_found';
    if (!response.ok) return 'unavailable';
    const value = (await response.json()) as { state?: unknown; target_stamp?: unknown };
    if (
      (value.state !== 'prepared' && value.state !== 'committed' && value.state !== 'cancelled') ||
      typeof value.target_stamp !== 'string'
    )
      return 'unavailable';
    return { state: value.state, target_stamp: value.target_stamp };
  } catch {
    return 'unavailable';
  }
}

export async function pendingAuthCredentialOperation(
  env: AuthEnv,
  grant: string,
  userId: string,
): Promise<string | null | 'unavailable'> {
  if (!TOKEN.test(grant)) return 'unavailable';
  try {
    const response = await postAuth(env, '/api/flaxia/credentials/pending', { grant, user_id: userId });
    if (!response.ok) return 'unavailable';
    const body = (await response.json()) as { operation?: unknown };
    if (body.operation === null) return null;
    return typeof body.operation === 'string' && TOKEN.test(body.operation) ? body.operation : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function cancelAuthCredentialHash(
  env: AuthEnv,
  operationHash: string,
  grant: string,
  userId: string,
): Promise<boolean> {
  if (!TOKEN.test(operationHash) || !TOKEN.test(grant)) return false;
  try {
    const response = await postAuth(env, '/api/flaxia/credentials/cancel-hash', {
      operation_hash: operationHash,
      grant,
      user_id: userId,
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function authEmailAction(
  env: AuthEnv,
  action: 'change' | 'status' | 'cancel' | 'ack',
  body: { operation_hash: string; grant: string; user_id: string; email?: string; current_srp?: unknown },
): Promise<{ status: 'ok' | 'missing' | 'denied' | 'unavailable'; state?: string; target_hash?: string }> {
  if (!TOKEN.test(body.operation_hash) || !TOKEN.test(body.grant)) return { status: 'denied' };
  try {
    const response = await postAuth(env, `/api/flaxia/email/${action}`, body);
    if (response.status === 404) return { status: 'missing' };
    if (response.status === 401 || response.status === 409 || response.status === 400) return { status: 'denied' };
    if (!response.ok) return { status: 'unavailable' };
    const result = (await response.json()) as { state?: unknown; target_hash?: unknown; success?: unknown };
    if (action === 'status') {
      if ((result.state !== 'committed' && result.state !== 'cancelled') || typeof result.target_hash !== 'string')
        return { status: 'unavailable' };
      return { status: 'ok', state: result.state, target_hash: result.target_hash };
    }
    return { status: result.success === true ? 'ok' : 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
export async function authCredentialOperation(
  env: AuthEnv,
  action: 'prepare' | 'commit' | 'cancel' | 'ack',
  body: CredentialOperation & Record<string, unknown>,
  expectedStamp?: string,
): Promise<'ok' | 'denied' | 'unavailable'> {
  if (!TOKEN.test(body.operation) || !TOKEN.test(body.grant)) return 'denied';
  try {
    const response = await postAuth(env, `/api/flaxia/credentials/${action}`, body);
    if ([400, 401, 404, 409].includes(response.status)) return 'denied';
    if (!response.ok) return 'unavailable';
    const result = (await response.json()) as { success?: unknown; target_stamp?: unknown };
    return result.success === true && (!expectedStamp || result.target_stamp === expectedStamp) ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// A redeemed grant has no owner until the local session is committed. Revoke
// it on rejection or an exception; expiry cleanup covers service outages.
export async function withPendingAuthGrant<T>(
  env: AuthEnv,
  grant: string,
  use: (commit: () => void) => Promise<T>,
): Promise<T> {
  let committed = false;
  try {
    return await use(() => {
      committed = true;
    });
  } finally {
    if (!committed && !(await revokeAuthGrant(env, grant))) {
      console.error('Failed to revoke an unclaimed Auth grant');
    }
  }
}

export async function sessionGrant(db: D1Database, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  if (TOKEN.test(sessionId)) return sessionId;
  const row = await db
    .prepare('SELECT grant_token FROM flaxia_auth_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<{ grant_token: string }>();
  return row?.grant_token ?? null;
}

export async function hasPendingAuthProvision(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        'SELECT 1 FROM flaxia_auth_provisioning WHERE user_id = ? UNION ALL SELECT 1 FROM flaxia_auth_links WHERE user_id = ? LIMIT 1',
      )
      .bind(userId, userId)
      .first(),
  );
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
    ) {
      return null;
    }
    return { challenge_id: body.challenge_id, salt: body.salt, B: body.B, srp_kdf: body.srp_kdf };
  } catch {
    return null;
  }
}

export async function startAuthRecoveryReauth(
  env: AuthEnv,
  grant: string,
  userId: string,
): Promise<{ challenge_id: string; salt: string; B: string; srp_kdf: string } | null> {
  try {
    const response = await postAuth(env, '/api/flaxia/recovery/reauth/start', { grant, user_id: userId });
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

export async function enrollAuthRecovery(
  env: AuthEnv,
  body: { grant: string; user_id: string; salt: string; verifier: string; kdf: string; current_srp: unknown },
): Promise<'ok' | 'denied' | 'unavailable'> {
  try {
    const response = await postAuth(env, '/api/flaxia/recovery/enroll', body);
    if ([400, 401, 409].includes(response.status)) return 'denied';
    if (!response.ok) return 'unavailable';
    return ((await response.json()) as { success?: unknown }).success === true ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function authRecoveryEnrolled(env: AuthEnv, grant: string, userId: string): Promise<boolean | null> {
  try {
    const response = await postAuth(env, '/api/flaxia/recovery/status', { grant, user_id: userId });
    if (!response.ok) return null;
    const body = (await response.json()) as { enrolled?: unknown };
    return typeof body.enrolled === 'boolean' ? body.enrolled : null;
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
): Promise<{
  user_id: string;
  grant: string;
  credential_stamp: string;
  legacy_stamp: string | null;
  username: string | null;
  display_name: string | null;
  email: string | null;
} | null> {
  if (!TOKEN.test(code) || !TOKEN.test(verifier)) return null;
  try {
    const response = await postAuth(env, '/api/flaxia/exchange', { code, verifier });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      user_id?: unknown;
      grant?: unknown;
      credential_stamp?: unknown;
      legacy_stamp?: unknown;
      username?: unknown;
      display_name?: unknown;
      email?: unknown;
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
    ) {
      if (typeof body.grant === 'string' && TOKEN.test(body.grant) && !(await revokeAuthGrant(env, body.grant))) {
        console.error('Failed to revoke an invalid Auth exchange grant');
      }
      return null;
    }
    return {
      user_id: body.user_id,
      grant: body.grant,
      credential_stamp: body.credential_stamp,
      legacy_stamp: body.legacy_stamp as string | null,
      username: typeof body.username === 'string' ? body.username : null,
      display_name: typeof body.display_name === 'string' ? body.display_name : null,
      email: typeof body.email === 'string' ? body.email : null,
    };
  } catch {
    return null;
  }
}

// Existing Flaxia sessions remain valid. Sessions issued from Auth are checked
// against the Auth session on every request so revocation takes effect.
export async function isSessionAuthorized(
  env: AuthEnv & { DB: D1Database },
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT grant_token, auth_stamp, source_stamp FROM flaxia_auth_sessions WHERE session_id = ?',
  )
    .bind(sessionId)
    .first<{ grant_token: string; auth_stamp: string; source_stamp: string }>();
  if (!row) return !authIsAuthoritative(env as AuthEnv);
  try {
    const pending = await env.DB.prepare(
      "SELECT operation_token FROM flaxia_auth_credential_jobs WHERE session_id = ? AND state = 'local_committed'",
    )
      .bind(sessionId)
      .first<{ operation_token: string | null }>();
    if (pending?.operation_token) {
      const { resumeAuthCredentialChange } = await import('./flaxia-auth-credentials.ts');
      if ((await resumeAuthCredentialChange(env as Env, pending.operation_token)) !== 'ok') return false;
    }
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
