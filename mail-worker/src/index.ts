/// <reference types="@cloudflare/workers-types" />
// flaxia-mail Worker (docs/mail.md §5). Internal API is Service-Binding-only:
// every fetch() call must carry a valid MAIL_INTERNAL_SECRET HMAC for the
// authenticated user id. The Worker never trusts a bare user id.
import { handleInboundEmail, type MailEnv } from './ingest.ts';

const MIME_MAX = 10 * 1024 * 1024;

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message) as BufferSource);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyInternal(env: MailEnv, req: Request): Promise<string | null> {
  const userId = req.headers.get('x-flaxia-user-id');
  const ts = req.headers.get('x-flaxia-ts');
  const sig = req.headers.get('x-flaxia-sig');
  const secret = env.MAIL_INTERNAL_SECRET;
  if (!userId || !ts || !sig || !secret) return null;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return null;
  const expected = await hmac(secret, `${userId}.${ts}`);
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < Math.max(expected.length, sig.length); i++) {
    diff |= (expected.charCodeAt(i) || 0) ^ (sig.charCodeAt(i) || 0);
  }
  return diff === 0 ? userId : null;
}

async function handleInternal(env: MailEnv, req: Request, userId: string): Promise<Response> {
  const url = new URL(req.url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (url.pathname === '/health') return json({ ok: true });
  if (req.method === 'GET' && url.pathname === '/internal/quota') {
    const row = await env.MAIL_DB.prepare(
      'SELECT storage_bytes, external_sends, external_day FROM mail_usage WHERE user_id = ?',
    )
      .bind(userId)
      .first();
    const today = new Date().toISOString().slice(0, 10);
    const sends = row?.external_day === today ? Number((row as Record<string, unknown>)?.external_sends ?? 0) : 0;
    return json({
      storage_bytes: Number((row as Record<string, unknown>)?.storage_bytes ?? 0),
      storage_quota_bytes: 512 * 1024 * 1024,
      external_sends: sends,
      daily_external_limit: 20,
    });
  }
  return json({ error: 'mail_not_implemented' }, 501);
}

export default {
  async fetch(req: Request, env: MailEnv): Promise<Response> {
    const userId = await verifyInternal(env, req);
    if (!userId)
      return new Response(JSON.stringify({ error: 'mail_unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    return handleInternal(env, req, userId);
  },

  async email(message: ForwardableEmailMessage, env: MailEnv): Promise<void> {
    // Cloudflare Email Routing -> email() handler. Size-guard before buffering.
    const raw = await new Response(message.raw).arrayBuffer();
    if (raw.byteLength > MIME_MAX) throw new Error('mail_too_large');
    await handleInboundEmail(env, raw, message.to);
  },

  async queue(batch: MessageBatch, env: MailEnv): Promise<void> {
    for (const msg of batch.messages) {
      try {
        // P1: no queue work yet; ack. P2 wires scan/index jobs here.
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<MailEnv>;
