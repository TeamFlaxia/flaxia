/// <reference types="@cloudflare/workers-types" />
// Shared HTTP helpers for the flaxia-mail Worker. Kept in one module so the
// internal routers (index.ts) and the send pipeline (send.ts) cannot drift on
// response shape, idempotency semantics, or body limits.
import type { MailEnv } from './ingest.ts';

export type Json = Record<string, unknown>;

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function error(code: string, status = 400): Response {
  return json({ error: code }, status);
}

export function idempotencyKey(req: Request): string | null {
  const value = req.headers.get('Idempotency-Key');
  return value && IDEMPOTENCY_PATTERN.test(value) ? value : null;
}

export async function claimIdempotency(env: MailEnv, userId: string, key: string): Promise<boolean> {
  const result = await env.MAIL_DB.prepare(
    'INSERT OR IGNORE INTO mail_idempotency_keys (user_id, idempotency_key) VALUES (?, ?)',
  )
    .bind(userId, key)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;

  // Opportunistic retention sweep; the table is operational, not archival.
  await env.MAIL_DB.prepare(
    `DELETE FROM mail_idempotency_keys
     WHERE user_id = ? AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`,
  )
    .bind(userId)
    .run()
    .catch(() => {});
  return true;
}

export async function readJsonBody(req: Request, maxBytes: number): Promise<Json | null> {
  const declared = Number(req.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const text = await req.text();
  if (text.length === 0 || text.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Json;
  } catch {
    return null;
  }
}
