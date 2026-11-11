/// <reference types="@cloudflare/workers-types" />

import { checkRateLimit, getClientIp } from '../rate-limit.ts';
import { localActorUsername } from './actor.ts';
import { resolveActorPublicKey } from './fetch.ts';
import { parseSignatureHeader, verifyDigest, verifyHttpSignature } from './signature.ts';

/**
 * The inbox of this instance.
 *
 * Both inbox endpoints (the personal inbox of an actor and the shared inbox
 * of the instance) share the same verification pipeline: the activity has to
 * be a signed ActivityPub document of a remote actor, the signature has to
 * be made with the key of that actor and the body has to be covered by the
 * digest of the request.
 */

export interface InboxEnv {
  DB: D1Database;
  BASE_URL: string;
  CACHE?: KVNamespace;
  AP_DELIVERY_QUEUE?: Queue;
  ENVIRONMENT?: string;
  AP_ALLOWED_PRIVATE_PEERS?: string;
  /**
   * Process the activity right away. The local development server has no
   * queue consumer, so a queued activity would never be handled. The binding
   * does not exist in production.
   */
  AP_DIRECT_DELIVERY?: string;
}

/** Activities are small JSON documents. */
export const MAX_INBOX_BODY_BYTES = 256 * 1024;

/** Maximum number of local accounts one delivery may address. */
const MAX_INBOX_TARGETS = 10;

export type InboxFailure =
  | { ok: false; status: number; error: string }
  | { ok: true; activity: Record<string, unknown>; actorId: string; username: string | null };

/** Read the body of an inbox request, rejecting oversized payloads. */
export async function readInboxBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_INBOX_BODY_BYTES) return null;
  const text = await req.text();
  if (text.length > MAX_INBOX_BODY_BYTES) return null;
  return text;
}

/**
 * Fingerprint of a delivery, used to drop an exact replay.
 *
 * The same signed request stays valid for the whole date window of the
 * signature, so recently seen requests are remembered for a bit longer than
 * that window.
 */
export async function inboxReplayKey(req: Request): Promise<string | null> {
  const signature = req.headers.get('Signature');
  const date = req.headers.get('Date');
  const digest = req.headers.get('Digest');
  if (!signature || !date || !digest) return null;
  try {
    const bytes = new TextEncoder().encode(`${signature}\n${date}\n${digest}`);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return `ap:replay:${Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
  } catch {
    return null;
  }
}

async function checkInboxRateLimit(env: InboxEnv, req: Request): Promise<boolean> {
  return checkRateLimit(env.CACHE, `ap:inbox:${getClientIp(req)}`, { maxRequests: 60, windowSeconds: 60 });
}

/**
 * The local accounts an activity addresses.
 *
 * Only URLs that really point at an actor of this instance count, and the
 * number of addressed accounts is capped: one signed activity must not fan
 * out to an unbounded number of queue messages.
 */
export function resolveLocalTargets(activity: Record<string, unknown>, baseUrl: string): string[] {
  const audience: unknown[] = [
    ...(Array.isArray(activity.to) ? activity.to : activity.to ? [activity.to] : []),
    ...(Array.isArray(activity.cc) ? activity.cc : activity.cc ? [activity.cc] : []),
  ].slice(0, 50);

  const targets = new Set<string>();
  for (const value of audience) {
    const username = localActorUsername(value, baseUrl);
    if (username) targets.add(username);
  }

  if (targets.size === 0) {
    const object = activity.object;
    const candidate = typeof object === 'string' ? object : ((object as { id?: unknown } | null)?.id ?? '');
    const username = localActorUsername(candidate, baseUrl);
    if (username) targets.add(username);
  }

  return [...targets].slice(0, MAX_INBOX_TARGETS);
}

/**
 * Verify an incoming activity.
 *
 * The actor of the activity and the key that signed the request have to
 * live on the same origin: otherwise a key from one instance could vouch
 * for an actor of another instance.
 */
export async function verifyIncomingActivity(env: InboxEnv, req: Request, body: string): Promise<InboxFailure> {
  let activity: Record<string, unknown>;
  try {
    activity = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }

  const actorId = activity.actor;
  if (!actorId || typeof actorId !== 'string') {
    return { ok: false, status: 400, error: 'Invalid actor' };
  }

  const signatureHeader = req.headers.get('Signature');
  if (!signatureHeader) {
    return { ok: false, status: 401, error: 'Missing HTTP Signature' };
  }

  let keyId: string | undefined;
  let keyIdOrigin: string | null = null;
  try {
    const parsed = parseSignatureHeader(signatureHeader);
    keyId = parsed.keyId;
    keyIdOrigin = new URL(parsed.keyId).origin;
    const actorOrigin = new URL(actorId).origin;
    if (keyIdOrigin !== actorOrigin) {
      console.error(`keyId origin ${keyIdOrigin} does not match actor origin ${actorOrigin}`);
      return { ok: false, status: 401, error: 'Invalid HTTP Signature: keyId/actor origin mismatch' };
    }
  } catch {
    return { ok: false, status: 400, error: 'Invalid keyId or actor URL' };
  }

  let expectedHost: string | undefined;
  try {
    expectedHost = new URL(actorId).host;
  } catch {
    expectedHost = undefined;
  }

  const publicKeyPem = await resolveActorPublicKey(actorId, env, keyId);
  if (!publicKeyPem) {
    return { ok: false, status: 401, error: 'Could not fetch actor public key' };
  }

  const signatureValid = await verifyHttpSignature(req, publicKeyPem, { expectedHost });
  if (!signatureValid) {
    return { ok: false, status: 401, error: 'Invalid HTTP Signature' };
  }

  const digestValid = await verifyDigest(req, body);
  if (!digestValid) {
    return { ok: false, status: 401, error: 'Invalid Digest' };
  }

  return { ok: true, activity, actorId, username: null };
}

/**
 * Hand an activity to the local accounts it addresses.
 *
 * The activity is queued so it is processed by the queue worker. Without a
 * consumer (the local development server) it is handled right away.
 */
async function enqueueForTargets(
  env: InboxEnv,
  targets: string[],
  activity: Record<string, unknown>,
  actorId: string,
): Promise<number> {
  if (env.AP_DIRECT_DELIVERY === '1' || env.AP_DIRECT_DELIVERY === 'true') {
    const { handleIncomingActivity } = await import('./handlers.ts');
    for (const username of targets) {
      await handleIncomingActivity(
        {
          DB: env.DB,
          BASE_URL: env.BASE_URL,
          AP_DELIVERY_QUEUE: env.AP_DELIVERY_QUEUE,
          ENVIRONMENT: env.ENVIRONMENT,
          AP_ALLOWED_PRIVATE_PEERS: env.AP_ALLOWED_PRIVATE_PEERS,
          AP_DIRECT_DELIVERY: env.AP_DIRECT_DELIVERY,
          CACHE: env.CACHE,
        },
        { activity, actorId, username },
      );
    }
    return targets.length;
  }

  if (!env.AP_DELIVERY_QUEUE) return 0;
  let queued = 0;
  for (const username of targets) {
    await env.AP_DELIVERY_QUEUE.send({
      type: 'inbox' as const,
      username,
      activity,
      actorId,
    });
    queued++;
  }
  return queued;
}

/**
 * The personal inbox of an actor.
 */
export async function handlePersonalInbox(env: InboxEnv, req: Request, username: string): Promise<Response> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/activity+json') && !contentType.includes('application/ld+json')) {
    return Response.json({ error: 'Invalid content type' }, { status: 400 });
  }

  if (!(await checkInboxRateLimit(env, req))) {
    return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first<{ id: string }>();
  if (!user) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const body = await readInboxBody(req);
  if (body === null) {
    return Response.json({ error: 'Inbox body too large' }, { status: 413 });
  }

  const verified = await verifyIncomingActivity(env, req, body);
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status });
  }

  await enqueueForTargets(env, [username], verified.activity, verified.actorId);
  return Response.json({ ok: true }, { status: 202 });
}

/**
 * The shared inbox of the instance.
 */
export async function handleSharedInbox(env: InboxEnv, req: Request): Promise<Response> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/activity+json') && !contentType.includes('application/ld+json')) {
    return Response.json({ error: 'Invalid content type' }, { status: 400 });
  }

  if (!(await checkInboxRateLimit(env, req))) {
    return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const body = await readInboxBody(req);
  if (body === null) {
    return Response.json({ error: 'Inbox body too large' }, { status: 413 });
  }

  const verified = await verifyIncomingActivity(env, req, body);
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status });
  }

  // Drop an exact replay of a delivery that was already accepted.
  const replayKey = await inboxReplayKey(req);
  if (replayKey && env.CACHE) {
    try {
      if (await env.CACHE.get(replayKey)) {
        return Response.json({ ok: true, duplicate: true }, { status: 202 });
      }
      await env.CACHE.put(replayKey, '1', { expirationTtl: 2100 });
    } catch {
      // fail open: bounded by the signature date window alone
    }
  }

  const targets = resolveLocalTargets(verified.activity, env.BASE_URL);
  if (targets.length === 0) {
    console.error(
      JSON.stringify({
        event: 'sharedInbox:no_target_user',
        activityType: verified.activity.type,
        actorId: verified.actorId,
        activityId: (verified.activity.id as string) || null,
        timestamp: new Date().toISOString(),
      }),
    );
    return Response.json({ ok: true }, { status: 202 });
  }

  await enqueueForTargets(env, targets, verified.activity, verified.actorId);
  return Response.json({ ok: true }, { status: 202 });
}
