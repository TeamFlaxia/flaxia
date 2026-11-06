// Flaxia Mail Pages proxy (docs/mail.md §8).
//
// Session auth runs here (requireAuth + CSRF + rate limit). The authenticated
// user id is forwarded to the flaxia-mail Worker via the MAIL_SERVICE service
// binding with an HMAC signature (MAIL_INTERNAL_SECRET). The Worker never
// trusts a bare user id from the browser.
//
// P1 ships: addresses, keys, quota. Threads/messages/send land in P2/P3.
import { Hono } from 'hono';
import { checkRateLimit } from '../../lib/rate-limit';
import { requireAuth } from '../helpers';
import type { Bindings as SharedBindings, Variables } from '../types';

type Bindings = SharedBindings & {
  // Duplicate of types.ts for direct router use; keeps tsc on one source.
  MAIL_SERVICE?: Fetcher;
  MAIL_INTERNAL_SECRET?: string;
  MAIL_DOMAIN?: string;
};

const mail = new Hono<{ Bindings: Bindings; Variables: Variables }>();

mail.use('*', requireAuth);

async function sign(env: Bindings, userId: string): Promise<Record<string, string>> {
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = env.MAIL_INTERNAL_SECRET;
  if (!secret) return { 'x-flaxia-user-id': userId, 'x-flaxia-ts': ts };
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${userId}.${ts}`) as BufferSource);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { 'x-flaxia-user-id': userId, 'x-flaxia-ts': ts, 'x-flaxia-sig': hex };
}

async function proxy(
  c: { env: Bindings; get: (k: 'user') => { id: string } | null; req: { method: string; url: string; raw: Request } },
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const user = c.get('user');
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const svc = (c.env as unknown as { MAIL_SERVICE?: Fetcher }).MAIL_SERVICE;
  if (!svc) return new Response(JSON.stringify({ error: 'mail_unavailable' }), { status: 503 });
  const headers = new Headers(init.headers);
  const sig = await sign(c.env, user.id);
  for (const [k, v] of Object.entries(sig)) headers.set(k, v);
  return svc.fetch(`https://flaxia-mail${path}`, { ...init, headers });
}

const RESERVED_LOCALS = new Set(['admin', 'abuse', 'dmarc', 'noreply', 'postmaster', 'security', 'support', 'team']);

export function primaryAddressFor(username: string, domain = 'flaxia.app'): string {
  const local = username.trim().toLowerCase();
  if (!/^[A-Za-z0-9_]{1,20}$/.test(local)) throw new Error('mail_invalid_username');
  if (RESERVED_LOCALS.has(local)) throw new Error('mail_reserved');
  return `${local}@${domain}`;
}

mail.get('/addresses', async (c) => {
  const res = await proxy(c, '/internal/addresses');
  return res;
});

mail.post('/addresses', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const allowed = await checkRateLimit(c.env.CACHE, `mail:address:${user.id}`, {
    maxRequests: 10,
    windowSeconds: 3600,
    failureMode: 'closed',
  }).catch(() => false);
  if (!allowed) return c.json({ error: 'mail_rate_limited' }, 429);

  const body = (await c.req.json().catch(() => ({}))) as {
    vault_unlocked?: unknown;
    public_key?: unknown;
    key_version?: unknown;
  };
  if (body.vault_unlocked !== true) return c.json({ error: 'mail_vault_required' }, 409);
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

mail.get('/keys/me', async (c) => {
  return proxy(c, '/internal/keys/me');
});

mail.put('/keys/me', async (c) => {
  const allowed = await checkRateLimit(c.env.CACHE, `mail:keys:${c.get('user')?.id}`, {
    maxRequests: 20,
    windowSeconds: 3600,
    failureMode: 'closed',
  }).catch(() => false);
  if (!allowed) return c.json({ error: 'mail_rate_limited' }, 429);
  return proxy(c, '/internal/keys/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: await c.req.text(),
  });
});

mail.get('/keys', async (c) => {
  const addresses = c.req.query('addresses') ?? '';
  return proxy(c, `/internal/keys?addresses=${encodeURIComponent(addresses)}`);
});

mail.post('/report-abuse', async (c) => {
  const allowed = await checkRateLimit(c.env.CACHE, `mail:report:${c.get('user')?.id}`, {
    maxRequests: 30,
    windowSeconds: 3600,
    failureMode: 'closed',
  }).catch(() => false);
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
