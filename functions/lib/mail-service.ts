// Signed client for the flaxia-mail Worker (docs/mail.md §5, §8).
//
// Pages Functions and account deletion both go through this module so the HMAC
// contract cannot drift. The signature binds the authenticated user id, the
// timestamp, the HTTP method, the exact path+query, and the body hash, so a
// captured signature cannot be replayed against a different endpoint.

import { signMailInternal } from '@flaxia/mail-contract';

export { sha256Hex } from './sha256.ts';
export { signMailInternal };

export type MailServiceEnv = {
  MAIL_SERVICE?: Fetcher;
  MAIL_INTERNAL_SECRET?: string;
};

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
