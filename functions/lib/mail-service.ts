// Signed client for the flaxia-mail Worker (docs/mail.md §5, §8).
//
// Pages Functions and account deletion both go through this module so the HMAC
// contract cannot drift. The signature binds the authenticated user id, the
// timestamp, the HTTP method, the exact path+query, and the body hash, so a
// captured signature cannot be replayed against a different endpoint.

export type MailServiceEnv = {
  MAIL_SERVICE?: Fetcher;
  MAIL_INTERNAL_SECRET?: string;
};

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message) as BufferSource);
  return hex(signature);
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value) as BufferSource));
}

export async function signMailInternal(
  env: MailServiceEnv,
  userId: string,
  method: string,
  path: string,
  body = '',
): Promise<Record<string, string> | null> {
  const secret = env.MAIL_INTERNAL_SECRET;
  if (!secret) return null;

  const ts = String(Math.floor(Date.now() / 1000));
  const target = new URL(`https://flaxia-mail${path}`);
  const message = `${userId}.${ts}.${method.toUpperCase()}.${target.pathname}${target.search}.${await sha256Hex(body)}`;
  return {
    'x-flaxia-user-id': userId,
    'x-flaxia-ts': ts,
    'x-flaxia-sig': await hmacHex(secret, message),
  };
}

export async function callMailService(
  env: MailServiceEnv,
  userId: string,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response | null> {
  const service = env.MAIL_SERVICE;
  if (!service) return null;

  const signature = await signMailInternal(env, userId, method, path, options.body ?? '');
  if (!signature) return null;

  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(signature)) headers.set(name, value);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = options.body;
  return service.fetch(`https://flaxia-mail${path}`, init);
}

/** Best-effort account deletion; callers must not fail the account delete. */
export async function deleteMailAccount(env: MailServiceEnv, userId: string): Promise<boolean> {
  const response = await callMailService(env, userId, 'DELETE', '/internal/delete-user');
  return Boolean(response?.ok);
}
