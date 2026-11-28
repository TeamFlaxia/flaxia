import { checkRateLimit, getClientIp } from '../rate-limit.ts';
import { localActorUsername } from './actor.ts';
import { isDirectDelivery } from './delivery.ts';
import { type FetchOptions, resolveActorPublicKey } from './fetch.ts';
import { actorSignOptions, ensureActorKey } from './keys.ts';
import {
  decodeSignatureBytes,
  parseRfc9421Signatures,
  parseSignatureHeader,
  rfc9421Param,
  type SignatureHeader,
  verifyDigest,
  verifyHttpSignature,
} from './signature.ts';

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
  | { ok: true; activity: Record<string, unknown>; actorId: string };

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
  const signatureHeader = req.headers.get('Signature');
  const digest = req.headers.get('Digest');
  const contentDigest = req.headers.get('Content-Digest');
  if (!signatureHeader || (!digest && !contentDigest)) return null;

  const parts: string[] = [];
  const signatureInput = req.headers.get('Signature-Input');
  const rfcSignatures = signatureInput ? parseRfc9421Signatures(signatureInput, signatureHeader) : [];
  if (rfcSignatures.length > 0) {
    // RFC 9421 has no single `keyId`/`signature` pair: hash every labelled
    // signature so that relabelling or dropping a label changes the key too.
    parts.push('rfc9421');
    for (const candidate of rfcSignatures) {
      const signatureBytes = decodeSignatureBytes(candidate.signature);
      if (!signatureBytes) return null;
      parts.push(
        candidate.label,
        rfc9421Param([candidate], 'keyid') ?? '',
        rfc9421Param([candidate], 'created') ?? '',
        rfc9421Param([candidate], 'expires') ?? '',
        hexBytes(signatureBytes),
      );
    }
  } else {
    let parsed: SignatureHeader;
    try {
      parsed = parseSignatureHeader(signatureHeader);
    } catch {
      return null;
    }
    const signatureBytes = decodeSignatureBytes(parsed.signature);
    if (!signatureBytes) return null;
    parts.push(
      'draft',
      parsed.keyId,
      parsed.created === undefined ? '' : String(parsed.created),
      parsed.expires === undefined ? '' : String(parsed.expires),
      hexBytes(signatureBytes),
    );
  }

  // Only the semantic parts of the signature enter the fingerprint: extra
  // parameters (algorithm, vendor extensions, ordering) must not turn the same
  // signed delivery into a different replay key. RFC 9421 signers may omit
  // Date and use `created`, and may send only Content-Digest.
  parts.push(req.headers.get('Date') ?? '', normalizeHeaderValue(digest), normalizeHeaderValue(contentDigest));
  try {
    const bytes = new TextEncoder().encode(parts.join('\n'));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return `ap:replay:${Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
  } catch {
    return null;
  }
}

/** Canonical representation of raw signature bytes in a fingerprint. */
function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Header values are compared semantically, not by incidental whitespace/case. */
function normalizeHeaderValue(value: string | null): string {
  return value ? value.replace(/\s+/g, '').toLowerCase() : '';
}

async function checkInboxRateLimit(env: InboxEnv, req: Request): Promise<boolean> {
  return checkRateLimit(env.CACHE, `ap:inbox:${getClientIp(req)}`, { maxRequests: 60, windowSeconds: 60 });
}

/**
 * Remember a verified delivery. Returns true when the exact request was
 * already accepted, so both inbox endpoints can drop a replay.
 */
async function isReplayDelivery(env: InboxEnv, req: Request): Promise<boolean> {
  const replayKey = await inboxReplayKey(req);
  if (!replayKey || !env.CACHE) return false;
  try {
    if (await env.CACHE.get(replayKey)) return true;
    await env.CACHE.put(replayKey, '1', { expirationTtl: 2100 });
  } catch {
    // fail open: bounded by the signature date window alone
  }
  return false;
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
export async function verifyIncomingActivity(
  env: InboxEnv,
  req: Request,
  body: string,
  signOptions: FetchOptions = {},
): Promise<InboxFailure> {
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
  try {
    // RFC 9421 puts the keyid in a `Signature-Input` parameter and uses a
    // labelled byte string in `Signature`. Draft-cavage peers put both in the
    // `Signature` header; double-knocking peers send both formats.
    if (req.headers.has('Signature-Input')) {
      const rfcSignatures = parseRfc9421Signatures(req.headers.get('Signature-Input') ?? '', signatureHeader);
      keyId = rfc9421Param(rfcSignatures, 'keyid');
    }
    if (!keyId) keyId = parseSignatureHeader(signatureHeader).keyId;

    const keyIdOrigin = new URL(keyId).origin;
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

  const publicKeyPem = await resolveActorPublicKey(actorId, env, keyId, signOptions);
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

  return { ok: true, activity, actorId };
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
  if (isDirectDelivery(env)) {
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
 * The options that sign the actor/key fetch with a local actor's key.
 *
 * Mastodon 4.4+ serves `/ap/users/:id` only to signed requests (authorized
 * fetch). Fetching the key unsigned returns 401, which used to reject every
 * Follow from such an instance before it was parsed.
 */
async function inboxSignOptions(env: InboxEnv, username: string): Promise<FetchOptions> {
  const existing = await actorSignOptions(env.DB, env.BASE_URL, username);
  if (existing.privateKeyPem) return existing;

  const user = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first<{ id: string }>();
  if (!user) return {};
  await ensureActorKey(env.DB, user.id);
  return actorSignOptions(env.DB, env.BASE_URL, username);
}

/** Pick the local target of a shared-inbox delivery and sign with its key. */
async function signOptionsForBody(env: InboxEnv, body: string): Promise<FetchOptions> {
  try {
    const activity = JSON.parse(body) as Record<string, unknown>;
    const target = resolveLocalTargets(activity, env.BASE_URL)[0];
    return target ? await inboxSignOptions(env, target) : {};
  } catch {
    return {};
  }
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

  const verified = await verifyIncomingActivity(env, req, body, await inboxSignOptions(env, username));
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status });
  }

  if (await isReplayDelivery(env, req)) {
    return Response.json({ ok: true, duplicate: true }, { status: 202 });
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

  const verified = await verifyIncomingActivity(env, req, body, await signOptionsForBody(env, body));
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status });
  }

  // Drop an exact replay of a delivery that was already accepted.
  if (await isReplayDelivery(env, req)) {
    return Response.json({ ok: true, duplicate: true }, { status: 202 });
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
