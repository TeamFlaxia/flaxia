// Flaxia Mail Pages proxy (docs/mail.md §8).
//
// Session auth runs here (requireAuth + CSRF + rate limit). The authenticated
// user id is forwarded to the flaxia-mail Worker via the MAIL_SERVICE service
// binding with an HMAC signature (MAIL_INTERNAL_SECRET). The Worker never
// trusts a bare user id from the browser.
//
// P1 ships: addresses, keys, quota. Threads/messages/send land in P2/P3.
import { type Context, Hono } from 'hono';
import { getSessionToken } from '../../lib/auth';
import { authIsAuthoritative, authVaultRequest, sessionGrant } from '../../lib/flaxia-auth';
import { ensureAuthVault } from '../../lib/flaxia-auth-vault';
import { callMailService } from '../../lib/mail-service';
import { checkRateLimit } from '../../lib/rate-limit';
import { requireAuth } from '../helpers';
import type { Bindings as SharedBindings, Variables } from '../types';

type Bindings = SharedBindings & {
  // Duplicate of types.ts for direct router use; keeps tsc on one source.
  MAIL_SERVICE?: Fetcher;
  MAIL_INTERNAL_SECRET?: string;
  MAIL_DOMAIN?: string;
};

type MailContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const mail = new Hono<{ Bindings: Bindings; Variables: Variables }>();

mail.use('*', requireAuth);

async function proxy(c: MailContext, path: string, init: RequestInit = {}): Promise<Response> {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const method = (init.method ?? 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : undefined;
  const headers: Record<string, string> = {};
  const contentType = new Headers(init.headers).get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await callMailService(c.env, user.id, method, path, body === undefined ? { headers } : { body, headers });
  if (!res) return c.json({ error: 'mail_unavailable' }, 503);
  return res;
}

async function allow(c: MailContext, key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
  return checkRateLimit(c.env.CACHE, key, { maxRequests, windowSeconds, failureMode: 'closed' }).catch(() => false);
}

/**
 * D4 requires an enabled Personal Vault before a Mail address exists. The
 * client's `vault_unlocked` flag is only a hint; this is the authoritative
 * check. With Auth as the vault owner the envelope is read through the same
 * grant-backed proxy the vault router uses.
 */
async function hasEnabledVault(c: MailContext, userId: string): Promise<boolean> {
  if (authIsAuthoritative(c.env)) {
    const token = getSessionToken(c.req.raw);
    if (!token) return false;
    const grant = await sessionGrant(c.env.DB, token);
    if (!grant) return false;
    if (!(await ensureAuthVault(c.env, grant, userId))) return false;
    const result = await authVaultRequest(c.env, grant, userId, 'GET', '/api/vault/keys');
    return result?.status === 200 && result.body.enabled === true;
  }

  const row = await c.env.DB.prepare('SELECT user_id FROM vault_keys WHERE user_id = ?').bind(userId).first();
  return Boolean(row);
}

const RESERVED_LOCALS = new Set(['admin', 'abuse', 'dmarc', 'noreply', 'postmaster', 'security', 'support', 'team']);

export function primaryAddressFor(username: string, domain = 'flaxia.app'): string {
  const local = username.trim().toLowerCase();
  if (!/^[A-Za-z0-9_]{1,20}$/.test(local)) throw new Error('mail_invalid_username');
  if (RESERVED_LOCALS.has(local)) throw new Error('mail_reserved');
  return `${local}@${domain}`;
}

mail.get('/addresses', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await allow(c, `mail:address-list:${user.id}`, 60, 3600))) {
    return c.json({ error: 'mail_rate_limited' }, 429);
  }
  return proxy(c, '/internal/addresses');
});

mail.post('/addresses', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const allowed = await allow(c, `mail:address:${user.id}`, 10, 3600);
  if (!allowed) return c.json({ error: 'mail_rate_limited' }, 429);

  const body = (await c.req.json().catch(() => ({}))) as {
    public_key?: unknown;
    key_version?: unknown;
  };
  if (!(await hasEnabledVault(c, user.id))) return c.json({ error: 'mail_vault_required' }, 409);
  if (typeof body.public_key !== 'string' || body.public_key.length === 0 || body.public_key.length > 500) {
    return c.json({ error: 'mail_invalid_public_key' }, 400);
  }
  const keyVersion = Number(body.key_version ?? 1);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) return c.json({ error: 'mail_invalid_key_version' }, 400);

  let address: string;
  try {
    address = primaryAddressFor(user.username, (c.env as unknown as { MAIL_DOMAIN?: string }).MAIL_DOMAIN);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const domain = (c.env as unknown as { MAIL_DOMAIN?: string }).MAIL_DOMAIN ?? 'flaxia.app';
  return proxy(c, '/internal/addresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, domain, public_key: body.public_key, key_version: keyVersion }),
  });
});

mail.get('/quota', async (c) => {
  return proxy(c, '/internal/quota');
});

mail.get('/unread', async (c) => {
  return proxy(c, '/internal/unread');
});

mail.get('/keys/me', async (c) => {
  return proxy(c, '/internal/keys/me');
});

mail.put('/keys/me', async (c) => {
  const allowed = await allow(c, `mail:keys:${c.get('user')?.id}`, 20, 3600);
  if (!allowed) return c.json({ error: 'mail_rate_limited' }, 429);
  return proxy(c, '/internal/keys/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: await c.req.text(),
  });
});

mail.get('/keys', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await allow(c, `mail:key-lookup:${user.id}`, 120, 3600))) {
    return c.json({ error: 'mail_rate_limited' }, 429);
  }
  const addresses = c.req.query('addresses') ?? '';
  return proxy(c, `/internal/keys?addresses=${encodeURIComponent(addresses)}`);
});

mail.post('/report-abuse', async (c) => {
  const allowed = await allow(c, `mail:report:${c.get('user')?.id}`, 30, 3600);
  if (!allowed) return c.json({ error: 'mail_rate_limited' }, 429);
  return proxy(c, '/internal/report-abuse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await c.req.text(),
  });
});

// P2/P3 stubs — explicit 501 so the client can feature-detect.
for (const [method, route] of [
  ['GET', '/threads'],
  ['GET', '/threads/:id'],
  ['GET', '/messages/:id'],
  ['GET', '/messages/:id/payload'],
  ['POST', '/messages'],
  ['POST', '/drafts'],
  ['PATCH', '/drafts/:id'],
  ['DELETE', '/drafts/:id'],
  ['POST', '/messages/actions'],
  ['GET', '/labels'],
  ['POST', '/labels'],
  ['PATCH', '/labels/:id'],
  ['DELETE', '/labels/:id'],
  ['PUT', '/messages/:id/labels'],
  ['GET', '/contacts'],
] as const) {
  // @ts-expect-error Hono route registration is dynamic here.
  mail[method.toLowerCase()](route, async (c) => c.json({ error: 'mail_not_implemented' }, 501));
}

export default mail;
