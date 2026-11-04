import type { Context } from 'hono';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getSession,
  getSessionToken,
  loginUser,
  registerUser,
  setSessionCookie,
  startSrpLogin,
  upgradeSrp,
  verifyPassword,
  verifySrpLogin,
  verifySrpPassword,
} from '../../lib/auth';
import { safeReturnPath } from '../../lib/auth-redirect';
import {
  authIsAuthoritative,
  authRecoveryEnrolled,
  completeAuthLink,
  credentialStampFor,
  enrollAuthRecovery,
  exchangeAuthCode,
  hasPendingAuthProvision,
  pendingAuthCredentialOperation,
  provisionAuthAccount,
  purgeLinkedLocalCredentials,
  revokeAuthGrant,
  sessionGrant,
  startAuthReauth,
  startAuthRecoveryReauth,
  withPendingAuthGrant,
} from '../../lib/flaxia-auth';
import { resumeAuthCredentialChange } from '../../lib/flaxia-auth-credentials';
import { cancelStaleDirectCredentialChange, resumeDirectCredentialChange } from '../../lib/flaxia-direct-credentials';
import { NATIVE_APP_ORIGINS } from '../../lib/native-origins';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { ensureNewcomerTitle } from '../../lib/titles';
import { getBaseOrigin, requireAuth } from '../helpers';
import type { Bindings, SrpProofBody, Variables } from '../types';

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type AuthContext = Context<{ Bindings: Bindings; Variables: Variables }>;

auth.get('/mode', (c) => c.json({ authority: authIsAuthoritative(c.env) ? 'flaxia-auth' : 'flaxia' }));

auth.get('/recovery/status', requireAuth, async (c) => {
  c.header('Cache-Control', 'no-store');
  const user = c.get('user');
  const grant = await sessionGrant(c.env.DB, getSessionToken(c.req.raw));
  if (!user || !grant) return c.json({ error: 'Recovery unavailable' }, 403);
  const enrolled = await authRecoveryEnrolled(c.env, grant, user.id);
  return enrolled === null ? c.json({ error: 'Auth unavailable' }, 503) : c.json({ enrolled });
});

auth.post('/recovery/enroll', requireAuth, async (c) => {
  const user = c.get('user');
  const grant = await sessionGrant(c.env.DB, getSessionToken(c.req.raw));
  if (!user || !grant) return c.json({ error: 'Recovery unavailable' }, 403);
  const limited = await rateLimit(c, 'auth:recovery-enroll', user.id, 10, 60);
  if (limited) return limited;
  const body = (await c.req.json().catch(() => null)) as {
    salt?: unknown;
    verifier?: unknown;
    kdf?: unknown;
    current_srp?: unknown;
  } | null;
  if (!body || typeof body.salt !== 'string' || typeof body.verifier !== 'string' || typeof body.kdf !== 'string')
    return c.json({ error: 'Invalid request' }, 400);
  const result = await enrollAuthRecovery(c.env, {
    grant,
    user_id: user.id,
    salt: body.salt,
    verifier: body.verifier,
    kdf: body.kdf,
    current_srp: body.current_srp,
  });
  return result === 'ok'
    ? c.json({ success: true })
    : c.json({ error: 'Recovery enrollment failed' }, result === 'denied' ? 401 : 503);
});

auth.post('/recovery/reauth/start', requireAuth, async (c) => {
  const user = c.get('user');
  const grant = await sessionGrant(c.env.DB, getSessionToken(c.req.raw));
  if (!user || !grant) return c.json({ error: 'Recovery unavailable' }, 403);
  const limited = await rateLimit(c, 'auth:recovery-reauth', user.id, 10, 60);
  if (limited) return limited;
  const challenge = await startAuthRecoveryReauth(c.env, grant, user.id);
  return challenge ? c.json(challenge) : c.json({ error: 'Recovery unavailable' }, 401);
});

// If the initiating browser lost its retry capability after Flaxia committed,
// prove the new local SRP password before the server resumes the Auth commit.
auth.post('/flaxia/credential-recovery/start', async (c) => {
  const limited = await rateLimit(c, 'auth:credential-recovery-start:ip', getClientIp(c.req.raw), 10, 60);
  if (limited) return limited;
  const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
  if (!body || typeof body.email !== 'string' || body.email.length > 254)
    return c.json({ error: 'Invalid request' }, 400);
  const user = await c.env.DB.prepare(
    "SELECT u.id FROM users u JOIN flaxia_auth_credential_jobs j ON j.user_id = u.id WHERE lower(u.email) = ? AND u.frozen_at IS NULL AND j.state = 'local_committed' AND j.operation_token IS NOT NULL",
  )
    .bind(body.email.trim().toLowerCase())
    .first<{ id: string }>();
  if (!user) return c.json({ error: 'Recovery unavailable' }, 401);
  const userLimited = await rateLimit(c, 'auth:credential-recovery-start:user', user.id, 10, 60);
  if (userLimited) return userLimited;
  const hs = await startSrpLogin(c.env, body.email);
  return hs
    ? c.json({ challenge_id: hs.challengeId, salt: hs.salt, B: hs.B, srp_kdf: hs.kdf })
    : c.json({ error: 'Recovery unavailable' }, 401);
});

auth.post('/flaxia/credential-recovery/verify', async (c) => {
  const limited = await rateLimit(c, 'auth:credential-recovery-verify:ip', getClientIp(c.req.raw), 10, 60);
  if (limited) return limited;
  const body = (await c.req.json().catch(() => null)) as {
    email?: unknown;
    challenge_id?: unknown;
    A?: unknown;
    M1?: unknown;
  } | null;
  if (
    !body ||
    typeof body.email !== 'string' ||
    body.email.length > 254 ||
    typeof body.challenge_id !== 'string' ||
    body.challenge_id.length > 64 ||
    typeof body.A !== 'string' ||
    body.A.length > 400 ||
    typeof body.M1 !== 'string' ||
    body.M1.length > 64
  )
    return c.json({ error: 'Invalid request' }, 400);
  const user = await c.env.DB.prepare(
    "SELECT u.id, j.operation_token FROM users u JOIN flaxia_auth_credential_jobs j ON j.user_id = u.id WHERE lower(u.email) = ? AND u.frozen_at IS NULL AND j.state = 'local_committed' AND j.operation_token IS NOT NULL",
  )
    .bind(body.email.trim().toLowerCase())
    .first<{ id: string; operation_token: string }>();
  if (!user) return c.json({ error: 'Recovery unavailable' }, 401);
  if (!(await verifySrpPassword(c.env, user.id, body.challenge_id, body.A, body.M1)))
    return c.json({ error: 'Recovery unavailable' }, 401);
  const result = await resumeAuthCredentialChange(c.env, user.operation_token);
  return result === 'ok' ? c.json({ success: true }) : c.json({ error: 'Recovery temporarily unavailable' }, 503);
});

// A local SRP proof is required before copying credentials to Auth. Retrying
// after an ambiguous service timeout is safe because Auth rejects conflicts.
auth.post('/flaxia/provision', requireAuth, async (c) => {
  const user = c.get('user');
  const token = getSessionToken(c.req.raw);
  if (!user || !token) return c.json({ error: 'Unauthorized' }, 401);
  if (await sessionGrant(c.env.DB, token)) return c.json({ error: 'Already linked' }, 409);
  const limited = await rateLimit(c, 'auth:flaxia-provision', user.id, 10, 60);
  if (limited) return limited;
  const body = (await c.req.json().catch(() => null)) as { challenge_id?: string; A?: string; M1?: string } | null;
  if (!body?.challenge_id || !body.A || !body.M1) return c.json({ error: 'Current password proof is required' }, 400);
  if (!(await verifySrpPassword(c.env, user.id, body.challenge_id, body.A, body.M1, token)))
    return c.json({ error: 'Current password is incorrect' }, 401);
  await c.env.DB.prepare(`INSERT OR IGNORE INTO flaxia_auth_provisioning
    (user_id, username, display_name, srp_salt, srp_verifier, srp_group, srp_kdf)
    SELECT id, username, display_name, srp_salt, srp_verifier, srp_group, srp_kdf FROM users
    WHERE id = ? AND frozen_at IS NULL AND srp_salt IS NOT NULL AND srp_verifier IS NOT NULL AND srp_group IS NOT NULL AND srp_kdf IS NOT NULL`)
    .bind(user.id)
    .run();
  const account = await c.env.DB.prepare(
    'SELECT p.user_id AS id, p.username, p.display_name, p.srp_salt, p.srp_verifier, p.srp_group, p.srp_kdf FROM flaxia_auth_provisioning p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.frozen_at IS NULL',
  )
    .bind(user.id)
    .first<{
      id: string;
      username: string;
      display_name: string;
      srp_salt: string | null;
      srp_verifier: string | null;
      srp_group: string | null;
      srp_kdf: string | null;
    }>();
  if (!account?.srp_salt || !account.srp_verifier || !account.srp_group || !account.srp_kdf)
    return c.json({ error: 'SRP migration required' }, 409);
  const result = await provisionAuthAccount(c.env, {
    user_id: account.id,
    username: account.username,
    display_name: account.display_name,
    srp_salt: account.srp_salt,
    srp_verifier: account.srp_verifier,
    srp_group: account.srp_group,
    srp_kdf: account.srp_kdf,
  });
  if (result === 'conflict') return c.json({ error: 'Auth account conflict' }, 409);
  if (result !== 'ok') return c.json({ error: 'Auth unavailable' }, 503);
  return c.json({ success: true });
});

// Activate only after account migration and all clients have switched to Auth.
// Existing local sessions are rejected by isSessionAuthorized in this mode.
for (const path of ['/register', '/login', '/login/start', '/login/verify', '/upgrade-srp']) {
  auth.use(path, async (c, next) => {
    if (authIsAuthoritative(c.env)) return c.json({ error: 'authentication_moved' }, 410);
    return next();
  });
}

type AuthIdentity = NonNullable<Awaited<ReturnType<typeof exchangeAuthCode>>>;
type ExchangeOutcome = { grant: string } | { error: string; status: 403 | 409 | 503 };

const AUTH_UI_ORIGIN = 'https://auth.flaxia.app';
const OAUTH_COOKIE = 'flaxia_oauth';
const OAUTH_COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/api/auth';

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function decodeBase64url(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function readOAuthCookie(request: Request): { v: string; s: string; r: string } | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${OAUTH_COOKIE}=`)) continue;
    try {
      const value = JSON.parse(decodeBase64url(trimmed.slice(OAUTH_COOKIE.length + 1))) as {
        v?: unknown;
        s?: unknown;
        r?: unknown;
      };
      if (
        typeof value.v !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.v) ||
        typeof value.s !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.s) ||
        typeof value.r !== 'string'
      )
        return null;
      return { v: value.v, s: value.s, r: value.r };
    } catch {
      return null;
    }
  }
  return null;
}

function oauthCookie(value: { v: string; s: string; r: string }): string {
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${OAUTH_COOKIE}=${encoded}; ${OAUTH_COOKIE_ATTRS}; Max-Age=600`;
}

function clearOAuthCookie(response: Response): void {
  response.headers.append('Set-Cookie', `${OAUTH_COOKIE}=; ${OAUTH_COOKIE_ATTRS}; Max-Age=0`);
}

async function commitAuthIdentity(env: Bindings, identity: AuthIdentity): Promise<ExchangeOutcome> {
  return withPendingAuthGrant(env, identity.grant, async (commit) => {
    let user = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND frozen_at IS NULL')
      .bind(identity.user_id)
      .first<{ id: string }>();
    if (
      !user &&
      authIsAuthoritative(env) &&
      identity.username &&
      /^[A-Za-z0-9_]{1,20}$/.test(identity.username) &&
      identity.display_name &&
      identity.display_name.length <= 50
    ) {
      // Registration is username-first: Auth accounts may have no email, but
      // the local profile still needs a unique, non-routable placeholder.
      const identityEmail =
        typeof identity.email === 'string' &&
        identity.email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)
          ? identity.email.toLowerCase()
          : `${identity.username.toLowerCase()}@users.flaxia.invalid`;
      try {
        // Never link by a matching username or email. A new profile and its
        // link are created together only for this authenticated Auth ID.
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO users (id, email, username, display_name, password_hash, srp_group) VALUES (?, ?, ?, ?, '', NULL)",
          ).bind(identity.user_id, identityEmail, identity.username, identity.display_name),
          env.DB.prepare('INSERT INTO flaxia_auth_links (user_id) VALUES (?)').bind(identity.user_id),
        ]);
        user = { id: identity.user_id };
      } catch {
        // Concurrent successful creation is safe only when the exact ID is
        // already linked. A conflicting existing profile is never adopted.
        user = await env.DB.prepare(
          'SELECT u.id FROM users u JOIN flaxia_auth_links l ON l.user_id = u.id WHERE u.id = ? AND u.frozen_at IS NULL',
        )
          .bind(identity.user_id)
          .first<{ id: string }>();
        if (!user) return { error: 'Profile conflict', status: 409 };
      }
    }
    if (!user) return { error: 'Account unavailable', status: 403 };
    // New Auth profiles and accounts linked before titles existed receive the
    // account-creation title on sign-in. Best-effort, like the local flows.
    await ensureNewcomerTitle(env.DB, user.id);
    if (authIsAuthoritative(env)) {
      const linked = await env.DB.prepare('SELECT 1 FROM flaxia_auth_links WHERE user_id = ?').bind(user.id).first();
      if (linked) {
        const pending = await pendingAuthCredentialOperation(env, identity.grant, user.id);
        if (pending === 'unavailable') return { error: 'Auth unavailable', status: 503 };
        if (pending) {
          const recovered = await resumeDirectCredentialChange(env, pending, identity.grant, user.id);
          if (recovered !== 'ok' && recovered !== 'cancelled')
            return { error: 'Account migration pending', status: 503 };
        } else if (!(await cancelStaleDirectCredentialChange(env, identity.grant, user.id)))
          return { error: 'Account migration pending', status: 503 };
        if (!(await purgeLinkedLocalCredentials(env.DB, user.id)))
          return { error: 'Account migration pending', status: 409 };
        if (!(await completeAuthLink(env, identity.grant, user.id))) return { error: 'Auth unavailable', status: 503 };
        commit();
        return { grant: identity.grant };
      }
    }
    const source = await env.DB.prepare(
      'SELECT password_hash, srp_salt, srp_verifier, srp_group, srp_kdf FROM users WHERE id = ? AND frozen_at IS NULL',
    )
      .bind(user.id)
      .first<{
        password_hash: string | null;
        srp_salt: string | null;
        srp_verifier: string | null;
        srp_group: string | null;
        srp_kdf: string | null;
      }>();
    if (!source) return { error: 'Account unavailable', status: 403 };
    const localStamp = await credentialStampFor(source);
    if (!localStamp || localStamp.stamp !== (localStamp.legacy ? identity.legacy_stamp : identity.credential_stamp))
      return { error: 'Account requires migration', status: 409 };
    const token = nanoid(32);
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const unchanged =
      'id = ? AND frozen_at IS NULL AND password_hash IS ? AND srp_salt IS ? AND srp_verifier IS ? AND srp_group IS ? AND srp_kdf IS ?';
    const snapshot = [
      user.id,
      source.password_hash,
      source.srp_salt,
      source.srp_verifier,
      source.srp_group,
      source.srp_kdf,
    ];
    if (authIsAuthoritative(env)) {
      const link = await env.DB.prepare(
        `INSERT OR IGNORE INTO flaxia_auth_links (user_id) SELECT id FROM users WHERE ${unchanged}`,
      )
        .bind(...snapshot)
        .run();
      if (!link.success) return { error: 'Account unavailable', status: 409 };
      const linked = await env.DB.prepare(
        `SELECT 1 FROM users WHERE ${unchanged} AND EXISTS (SELECT 1 FROM flaxia_auth_links WHERE user_id = users.id)`,
      )
        .bind(...snapshot)
        .first();
      if (!linked) return { error: 'Credentials changed', status: 409 };
      if (!(await purgeLinkedLocalCredentials(env.DB, user.id)))
        return { error: 'Account migration pending', status: 409 };
      if (!(await completeAuthLink(env, identity.grant, user.id))) return { error: 'Auth unavailable', status: 503 };
      commit();
      return { grant: identity.grant };
    }
    const inserted = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO flaxia_auth_links (user_id) SELECT id FROM users WHERE ${unchanged}`).bind(
        ...snapshot,
      ),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at) SELECT ?, id, ? FROM users WHERE ${unchanged}`,
      ).bind(token, expires, ...snapshot),
      env.DB.prepare(
        'INSERT INTO flaxia_auth_sessions (session_id, grant_token, auth_stamp, source_stamp) SELECT id, ?, ?, ? FROM sessions WHERE id = ?',
      ).bind(identity.grant, identity.credential_stamp, localStamp.stamp, token),
    ]);
    if (inserted[1].meta.changes !== 1 || inserted[2].meta.changes !== 1)
      return { error: 'Credentials changed', status: 409 };
    commit();
    return { grant: token };
  });
}

// Transitional and native clients redeem a code directly. Native apps send
// their bundled origin, which is allowlisted for the CSRF middleware but is not
// the base origin.
auth.post('/flaxia/exchange', async (c) => {
  const origin = c.req.header('Origin');
  // Native HTTP transports may omit Origin entirely. The one-time code and the
  // caller-held PKCE verifier are the authorization, not the browser origin.
  if (origin && origin !== getBaseOrigin(c) && !(NATIVE_APP_ORIGINS as readonly string[]).includes(origin))
    return c.json({ error: 'Invalid origin' }, 403);
  const limited = await rateLimit(c, 'auth:flaxia-exchange:ip', getClientIp(c.req.raw), 10, 60);
  if (limited) return limited;
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; verifier?: unknown } | null;
  if (!body || typeof body.code !== 'string' || typeof body.verifier !== 'string')
    return c.json({ error: 'Invalid request' }, 400);
  const identity = await exchangeAuthCode(c.env, body.code, body.verifier);
  if (!identity) return c.json({ error: 'Invalid authorization' }, 401);
  const outcome = await commitAuthIdentity(c.env, identity);
  if ('error' in outcome) return c.json({ error: outcome.error }, outcome.status);
  const response = c.json({ success: true });
  setSessionCookie(response, outcome.grant);
  return response;
});

// Browser entry point for the redirect-based login UI. The verifier and state
// live in an HttpOnly cookie so the code can only be redeemed by the browser
// that started the flow.
auth.get('/start', async (c) => {
  const limited = await rateLimit(c, 'auth:start:ip', getClientIp(c.req.raw), 30, 60);
  if (limited) return limited;
  const origin = getBaseOrigin(c);
  const requestUrl = new URL(c.req.url);
  const verifier = randomToken();
  const state = randomToken();
  const returnTo = safeReturnPath(requestUrl.searchParams.get('return_to'));
  const mode = requestUrl.searchParams.get('mode') === 'register' ? 'register' : null;

  const target = new URL('/login', c.env.AUTH_UI_ORIGIN || AUTH_UI_ORIGIN);
  target.searchParams.set('code_challenge', await pkceChallenge(verifier));
  target.searchParams.set('state', state);
  target.searchParams.set('return_uri', `${origin}/api/auth/callback`);
  if (mode) target.searchParams.set('mode', mode);

  const response = c.redirect(target.toString(), 302);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.append('Set-Cookie', oauthCookie({ v: verifier, s: state, r: returnTo }));
  return response;
});

auth.get('/callback', async (c) => {
  const limited = await rateLimit(c, 'auth:callback:ip', getClientIp(c.req.raw), 30, 60);
  if (limited) return limited;
  const pending = readOAuthCookie(c.req.raw);
  const code = c.req.query('code');
  const state = c.req.query('state');
  const fail = () => {
    const response = c.redirect('/login', 302);
    response.headers.set('Cache-Control', 'no-store');
    clearOAuthCookie(response);
    return response;
  };
  if (!pending || !code || !state || pending.s !== state) return fail();
  const identity = await exchangeAuthCode(c.env, code, pending.v);
  if (!identity) return fail();
  const outcome = await commitAuthIdentity(c.env, identity);
  if ('error' in outcome) return fail();
  const response = c.redirect(safeReturnPath(pending.r), 302);
  response.headers.set('Cache-Control', 'no-store');
  setSessionCookie(response, outcome.grant);
  clearOAuthCookie(response);
  return response;
});

/**
 * Local development and the test dev server must not be rate-limited: the
 * integration suite registers and logs in many users from a single IP.
 */
function isLocalEnvironment(c: AuthContext): boolean {
  // A single misconfigured BASE_URL or ENVIRONMENT must not disable protection.
  const localEnvironment = c.env.ENVIRONMENT === 'test' || c.env.ENVIRONMENT === 'development';
  let localAddress = false;
  try {
    const url = new URL(c.env.BASE_URL ?? '');
    localAddress = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    // A missing or invalid URL is never an authorization bypass.
  }
  return localEnvironment && localAddress;
}

/**
 * Apply a KV-backed rate limit. Returns a 429 Response when the limit is
 * exceeded, or null when the request may proceed. Returns 503 when KV
 * is unavailable so authentication cannot bypass its request ceiling.
 */
async function rateLimit(
  c: AuthContext,
  scope: string,
  id: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<Response | null> {
  if (isLocalEnvironment(c)) return null;
  let allowed: boolean;
  try {
    allowed = await checkRateLimit(c.env.CACHE, `${scope}:${id}`, {
      maxRequests,
      windowSeconds,
      failureMode: 'closed',
    });
  } catch (error) {
    console.error('Auth rate-limit storage unavailable', { scope, error });
    return c.json({ error: 'Authentication temporarily unavailable. Please retry shortly.' }, 503, {
      'Retry-After': '60',
    });
  }
  if (!allowed) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }
  return null;
}

// POST /api/auth/register
//
// SRP-only: the body carries a verifier the client derived locally, never the
// password. There is deliberately no plaintext `password` branch — a new
// account must not start life with a value the server can dictionary-attack
// outside the protocol. Password length policy lives client-side.
auth.post('/register', async (c) => {
  try {
    const limited = await rateLimit(c, 'auth:register', getClientIp(c.req.raw), 5, 60);
    if (limited) return limited;

    const { email, username, display_name, srp_salt, srp_verifier, srp_group, srp_kdf } = await c.req.json();

    if (!username || !display_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const usernameRegex = /^[a-zA-Z0-9_]{1,20}$/;
    if (!usernameRegex.test(username)) {
      return c.json({ error: 'Username must be 1-20 alphanumeric characters' }, 400);
    }

    if (display_name.length > 50) {
      return c.json({ error: 'Display name must be ≤50 characters' }, 400);
    }

    // Accounts are username-first. Email is optional, so local databases still
    // satisfy the NOT NULL column with a reserved, non-routable address.
    let normalizedEmail: string;
    if (email === undefined) {
      normalizedEmail = `${username.toLowerCase()}@users.flaxia.invalid`;
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      // Bound the string before it reaches the regex: overlapping `[^\s@]+`
      // classes backtrack quadratically on long dot-heavy input. Normalize
      // first: email is a case-insensitive identifier, not a display string.
      if (typeof email !== 'string') {
        return c.json({ error: 'Invalid email format' }, 400);
      }
      normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail.length === 0 || normalizedEmail.length > 254) {
        return c.json({ error: 'Invalid email format' }, 400);
      }
      if (!emailRegex.test(normalizedEmail)) {
        return c.json({ error: 'Invalid email format' }, 400);
      }
    }

    if (!srp_salt || !srp_verifier || !srp_group || !srp_kdf) {
      return c.json({ error: 'SRP verifier required (plaintext registration is not supported)' }, 400);
    }

    const user = await registerUser(c.env, {
      email: normalizedEmail,
      username,
      display_name,
      srp: {
        salt: srp_salt as string,
        verifier: srp_verifier as string,
        group: srp_group as string,
        kdf: srp_kdf as string,
      },
    });

    const session = await createSession(c.env, user.id);
    const response = c.json({ user }, 201);
    setSessionCookie(response, session.id);

    return response;
  } catch (error: unknown) {
    const message = (error as { message?: string })?.message || 'Unknown error';
    console.error('Registration error:', message);
    if (message === 'Email already registered' || message === 'Username already taken') {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: 'Registration failed. Please try again.' }, 400);
  }
});

// POST /api/auth/login — DEPRECATED plaintext fallback.
//
// Kept only so accounts created before SRP can still sign in: each such login
// is followed by the client calling /upgrade-srp, which replaces the plaintext
// hash with a v2 verifier. No new account can reach this path (registration is
// SRP-only), so the population served here only shrinks.
//
// CUTOFF: delete this route once
//   SELECT COUNT(*) FROM users WHERE srp_salt IS NULL
// reaches 0 (see GET /api/admin/auth-migration) — or once an email-based
// password reset exists, whichever lands first. Until then dormant legacy
// accounts would be locked out forever without it.
auth.post('/login', async (c) => {
  try {
    const body = (await c.req.json()) as { email?: unknown; username?: unknown; password?: unknown };
    const identifier = typeof body.username === 'string' ? body.username : body.email;
    const { password } = body;

    if (!identifier || !password) {
      return c.json({ error: 'Username and password required' }, 400);
    }

    const ip = getClientIp(c.req.raw);
    const limitedIp = await rateLimit(c, 'auth:login:ip', ip, 10, 60);
    if (limitedIp) return limitedIp;
    const limitedEmail = await rateLimit(c, 'auth:login:email', String(identifier).toLowerCase(), 5, 60);
    if (limitedEmail) return limitedEmail;

    const result = await loginUser(c.env, String(identifier), String(password));

    if (result.frozen) {
      return c.json({ error: 'account_frozen', username: result.user.username }, 403);
    }

    const response = c.json({ user: result.user });
    setSessionCookie(response, result.session.id);

    return response;
  } catch (error: unknown) {
    console.error('Login error:', error);
    return c.json({ error: 'Invalid credentials' }, 401);
  }
});

// POST /api/auth/login/start
auth.post('/login/start', async (c) => {
  try {
    const body = (await c.req.json()) as { email?: unknown; username?: unknown };
    const identifier = typeof body.username === 'string' ? body.username : body.email;
    if (!identifier) return c.json({ error: 'Username required' }, 400);
    // #98: canonicalize before keying the rate-limit bucket — otherwise
    // whitespace/case variants of one identifier each get a fresh bucket.
    // The handshake itself is bound to the resolved user, not the string.
    const canonicalIdentifier = typeof identifier === 'string' ? identifier.trim().toLowerCase().slice(0, 254) : '';
    if (!canonicalIdentifier) return c.json({ error: 'Username required' }, 400);

    const ip = getClientIp(c.req.raw);
    const limitedIp = await rateLimit(c, 'auth:srp-start:ip', ip, 10, 60);
    if (limitedIp) return limitedIp;
    const limitedEmail = await rateLimit(c, 'auth:srp-start:email', canonicalIdentifier, 5, 60);
    if (limitedEmail) return limitedEmail;

    const hs = await startSrpLogin(c.env, String(identifier));
    if (!hs) return c.json({ srp: false });

    return c.json({ srp: true, challenge_id: hs.challengeId, salt: hs.salt, B: hs.B, srp_kdf: hs.kdf });
  } catch (error: unknown) {
    console.error('SRP login/start error:', error);
    return c.json({ error: 'Login failed' }, 500);
  }
});

// POST /api/auth/login/verify
auth.post('/login/verify', async (c) => {
  try {
    const body = (await c.req.json()) as {
      email?: unknown;
      username?: unknown;
      challenge_id?: unknown;
      A?: unknown;
      M1?: unknown;
    };
    const identifier = typeof body.username === 'string' ? body.username : body.email;
    const { challenge_id, A, M1 } = body as { challenge_id?: string; A?: string; M1?: string };
    if (!identifier || !challenge_id || !A || !M1) {
      return c.json({ error: 'Missing SRP parameters' }, 400);
    }

    const ip = getClientIp(c.req.raw);
    const limitedIp = await rateLimit(c, 'auth:srp-verify:ip', ip, 10, 60);
    if (limitedIp) return limitedIp;
    const limitedEmail = await rateLimit(
      c,
      'auth:srp-verify:email',
      String(identifier).trim().toLowerCase().slice(0, 254),
      5,
      60,
    );
    if (limitedEmail) return limitedEmail;

    const result = await verifySrpLogin(c.env, String(identifier), challenge_id, A, M1);
    if (!result) return c.json({ error: 'Invalid credentials' }, 401);

    if (result.frozen) {
      return c.json({ error: 'account_frozen', username: result.user.username, M2: result.M2 }, 403);
    }

    const response = c.json({ user: result.user, M2: result.M2 });
    setSessionCookie(response, result.session.id);
    return response;
  } catch (error: unknown) {
    console.error('SRP login/verify error:', error);
    return c.json({ error: 'Invalid credentials' }, 401);
  }
});

// POST /api/auth/reauth/start
auth.post('/reauth/start', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    // Same throttle as login/start: each call mints a handshake row holding
    // server secrets, and expired rows are never reaped.
    const limited = await rateLimit(c, 'auth:reauth-start', user.id, 10, 60);
    if (limited) return limited;
    const grant = await sessionGrant(c.env.DB, getSessionToken(c.req.raw));
    if (grant) {
      const challenge = await startAuthReauth(c.env, grant, user.id);
      return challenge ? c.json(challenge) : c.json({ error: 'Re-auth failed' }, 503);
    }
    if (!user.email) return c.json({ error: 'Unauthorized' }, 401);
    const hs = await startSrpLogin(c.env, user.email);
    if (!hs) return c.json({ error: 'SRP not available' }, 400);
    return c.json({ challenge_id: hs.challengeId, salt: hs.salt, B: hs.B, srp_kdf: hs.kdf });
  } catch (error: unknown) {
    console.error('SRP reauth/start error:', error);
    return c.json({ error: 'Re-auth failed' }, 500);
  }
});

// POST /api/auth/reauth/verify
auth.post('/reauth/verify', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const limited = await rateLimit(c, 'auth:reauth-verify', user.id, 10, 60);
    if (limited) return limited;
    const { challenge_id, A, M1 } = (await c.req.json()) as {
      challenge_id?: string;
      A?: string;
      M1?: string;
    };
    if (!challenge_id || !A || !M1) return c.json({ error: 'Missing SRP parameters' }, 400);
    const ok = await verifySrpPassword(c.env, user.id, challenge_id, A, M1, getSessionToken(c.req.raw));
    return c.json({ valid: ok });
  } catch (error: unknown) {
    console.error('SRP reauth/verify error:', error);
    return c.json({ error: 'Verification failed' }, 500);
  }
});

// POST /api/auth/upgrade-srp
//
// The only endpoint that changes how a verifier was derived. Callers hold the
// plaintext password at this moment (legacy login just happened, or the user is
// mid password-change / vault-enable), so the expensive KDF runs client-side
// and this handler only stores the result.
auth.post('/upgrade-srp', requireAuth, async (c) => {
  try {
    // #90: upgrades mint long-lived credentials — throttle per account so a
    // stolen session cannot be used for unbounded verifier swapping.
    const limiterUserId = c.get('user')?.id ?? getClientIp(c.req.raw);
    const limited = await rateLimit(c, 'auth:upgrade-srp', limiterUserId, 10, 3600);
    if (limited) return limited;
    const { srp_salt, srp_verifier, srp_group, srp_kdf, current_srp, legacy_password } = await c.req.json();
    if (!srp_salt || !srp_verifier || !srp_group || !srp_kdf) {
      return c.json({ error: 'Missing SRP parameters' }, 400);
    }
    const userId = c.get('user')?.id;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    if (await sessionGrant(c.env.DB, getSessionToken(c.req.raw)))
      return c.json({ error: 'Credential changes unavailable for Auth sessions' }, 409);
    if (await hasPendingAuthProvision(c.env.DB, userId))
      return c.json({ error: 'Credential changes unavailable during Auth migration' }, 409);
    const existing = (await c.env.DB.prepare('SELECT srp_verifier, srp_salt, password_hash FROM users WHERE id = ?')
      .bind(userId)
      .first()) as {
      srp_verifier: string | null;
      srp_salt: string | null;
      password_hash: string | null;
    } | null;
    if (existing?.srp_verifier || existing?.srp_salt) {
      const proof = current_srp as SrpProofBody | undefined;
      if (!proof?.challenge_id || !proof.A || !proof.M1) {
        return c.json({ error: 'Current password proof is required' }, 400);
      }
      if (!(await verifySrpPassword(c.env, userId, proof.challenge_id, proof.A, proof.M1))) {
        return c.json({ error: 'Current password is incorrect' }, 401);
      }
    } else {
      const token = getSessionToken(c.req.raw);
      const session = token ? await getSession(c.env, token) : null;
      if (!session?.session.srp_upgrade_allowed) {
        return c.json({ error: 'Legacy login required for SRP upgrade' }, 403);
      }
      // A session bit is not a password proof. Legacy accounts have no SRP
      // verifier yet, so require the original password and verify its hash
      // before permanently replacing the account's login credential.
      if (
        typeof legacy_password !== 'string' ||
        legacy_password.length === 0 ||
        legacy_password.length > 1024 ||
        !existing?.password_hash ||
        !(await verifyPassword(legacy_password, existing.password_hash))
      ) {
        return c.json({ error: 'Current password is incorrect' }, 401);
      }
    }
    await upgradeSrp(
      c.env,
      userId,
      {
        salt: srp_salt,
        verifier: srp_verifier,
        group: srp_group,
        kdf: srp_kdf,
      },
      { onlyIfLegacy: !(existing?.srp_verifier || existing?.srp_salt) },
    );
    const token = getSessionToken(c.req.raw);
    if (token) {
      await c.env.DB.prepare('UPDATE sessions SET srp_upgrade_allowed = 0 WHERE id = ?').bind(token).run();
    }
    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('SRP upgrade error:', error);
    return c.json({ error: 'Upgrade failed' }, 400);
  }
});

// POST /api/auth/logout
// Clears the cookie unconditionally: behind requireAuth a dead/expired
// session would 401 before clearSessionCookie ever ran, leaving the client
// sending the dead cookie forever.
auth.post('/logout', async (c) => {
  try {
    const token = getSessionToken(c.req.raw);
    if (token) {
      const grant = await sessionGrant(c.env.DB, token);
      const revoked = !grant || (await revokeAuthGrant(c.env, grant));
      if (!revoked) {
        // Keep the cookie and grant mapping so the caller can safely retry.
        return c.json({ error: 'auth_revocation_unavailable' }, 503);
      }
      await deleteSession(c.env, token);
    }

    const response = c.json({ success: true });
    clearSessionCookie(response);

    return response;
  } catch (error: unknown) {
    console.error('Logout error:', error);
    return c.json({ error: 'logout_unavailable' }, 503);
  }
});

export default auth;
