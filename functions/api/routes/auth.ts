import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getSessionToken,
  loginUser,
  registerUser,
  setSessionCookie,
  startSrpLogin,
  upgradeSrp,
  verifySrpLogin,
  verifySrpPassword,
} from '../../lib/auth';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type AuthContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Local development and the test dev server must not be rate-limited: the
 * integration suite registers and logs in many users from a single IP.
 */
function isLocalEnvironment(c: AuthContext): boolean {
  return c.env.ENVIRONMENT === 'test' || (c.env.BASE_URL ?? '').startsWith('http://localhost');
}

/**
 * Apply a KV-backed rate limit. Returns a 429 Response when the limit is
 * exceeded, or null when the request may proceed. Falls through (allows) if KV
 * is unavailable, matching the behaviour of the shared limiter.
 */
async function rateLimit(
  c: AuthContext,
  scope: string,
  id: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<Response | null> {
  if (isLocalEnvironment(c)) return null;
  const allowed = await checkRateLimit(c.env.CACHE, `${scope}:${id}`, { maxRequests, windowSeconds });
  if (!allowed) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }
  return null;
}

// POST /api/auth/register
auth.post('/register', async (c) => {
  try {
    const limited = await rateLimit(c, 'auth:register', getClientIp(c.req.raw), 5, 60);
    if (limited) return limited;

    const { email, password, username, display_name, srp_salt, srp_verifier, srp_group } = await c.req.json();

    if (!email || !username || !display_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    const usernameRegex = /^[a-zA-Z0-9_]{1,20}$/;
    if (!usernameRegex.test(username)) {
      return c.json({ error: 'Username must be 1-20 alphanumeric characters' }, 400);
    }

    if (display_name.length > 50) {
      return c.json({ error: 'Display name must be ≤50 characters' }, 400);
    }

    const srp =
      srp_salt && srp_verifier && srp_group
        ? { salt: srp_salt as string, verifier: srp_verifier as string, group: srp_group as string }
        : undefined;

    if (!srp) {
      if (!password) {
        return c.json({ error: 'Password or SRP verifier required' }, 400);
      }
      if (password.length < 8 || password.length > 128) {
        return c.json({ error: 'Password must be 8-128 characters' }, 400);
      }
    }

    const user = await registerUser(c.env, {
      email,
      password,
      username,
      display_name,
      srp,
    });

    const session = await createSession(c.env, user.id);
    const response = c.json({ user }, 201);
    setSessionCookie(response, session.id);

    return response;
  } catch (error: unknown) {
    const message = (error as { message?: string })?.message || 'Unknown error';
    console.error('Registration error:', message);
    return c.json({ error: 'Registration failed. Please try again.' }, 400);
  }
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  try {
    const { email, password } = await c.req.json();

    if (!email || !password) {
      return c.json({ error: 'Email and password required' }, 400);
    }

    const ip = getClientIp(c.req.raw);
    const limitedIp = await rateLimit(c, 'auth:login:ip', ip, 10, 60);
    if (limitedIp) return limitedIp;
    const limitedEmail = await rateLimit(c, 'auth:login:email', String(email).toLowerCase(), 5, 60);
    if (limitedEmail) return limitedEmail;

    const result = await loginUser(c.env, email, password);

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
    const { email } = await c.req.json();
    if (!email) return c.json({ error: 'Email required' }, 400);

    const ip = getClientIp(c.req.raw);
    const limitedIp = await rateLimit(c, 'auth:srp-start:ip', ip, 10, 60);
    if (limitedIp) return limitedIp;
    const limitedEmail = await rateLimit(c, 'auth:srp-start:email', String(email).toLowerCase(), 5, 60);
    if (limitedEmail) return limitedEmail;

    const hs = await startSrpLogin(c.env, email);
    if (!hs) return c.json({ srp: false });

    return c.json({ srp: true, challenge_id: hs.challengeId, salt: hs.salt, B: hs.B });
  } catch (error: unknown) {
    console.error('SRP login/start error:', error);
    return c.json({ error: 'Login failed' }, 500);
  }
});

// POST /api/auth/login/verify
auth.post('/login/verify', async (c) => {
  try {
    const { email, challenge_id, A, M1 } = await c.req.json();
    if (!email || !challenge_id || !A || !M1) {
      return c.json({ error: 'Missing SRP parameters' }, 400);
    }

    const ip = getClientIp(c.req.raw);
    const limitedIp = await rateLimit(c, 'auth:srp-verify:ip', ip, 10, 60);
    if (limitedIp) return limitedIp;
    const limitedEmail = await rateLimit(c, 'auth:srp-verify:email', String(email).toLowerCase(), 5, 60);
    if (limitedEmail) return limitedEmail;

    const result = await verifySrpLogin(c.env, email, challenge_id, A, M1);
    if (!result) return c.json({ error: 'Invalid credentials' }, 401);

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
    if (!user?.email) return c.json({ error: 'Unauthorized' }, 401);
    const hs = await startSrpLogin(c.env, user.email);
    if (!hs) return c.json({ error: 'SRP not available' }, 400);
    return c.json({ challenge_id: hs.challengeId, salt: hs.salt, B: hs.B });
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
    const { challenge_id, A, M1 } = (await c.req.json()) as {
      challenge_id?: string;
      A?: string;
      M1?: string;
    };
    if (!challenge_id || !A || !M1) return c.json({ error: 'Missing SRP parameters' }, 400);
    const ok = await verifySrpPassword(c.env, user.id, challenge_id, A, M1);
    return c.json({ valid: ok });
  } catch (error: unknown) {
    console.error('SRP reauth/verify error:', error);
    return c.json({ error: 'Verification failed' }, 500);
  }
});

// POST /api/auth/upgrade-srp
auth.post('/upgrade-srp', requireAuth, async (c) => {
  try {
    const { srp_salt, srp_verifier, srp_group } = await c.req.json();
    if (!srp_salt || !srp_verifier || !srp_group) {
      return c.json({ error: 'Missing SRP parameters' }, 400);
    }
    const userId = c.get('user')?.id;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    await upgradeSrp(c.env, userId, {
      salt: srp_salt,
      verifier: srp_verifier,
      group: srp_group,
    });
    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('SRP upgrade error:', error);
    return c.json({ error: 'Upgrade failed' }, 400);
  }
});

// POST /api/auth/logout
auth.post('/logout', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw);
    if (token) {
      await deleteSession(c.env, token);
    }

    const response = c.json({ success: true });
    clearSessionCookie(response);

    return response;
  } catch (error: unknown) {
    console.error('Logout error:', error);
    return c.json({ error: 'Logout failed' }, 500);
  }
});

export default auth;
