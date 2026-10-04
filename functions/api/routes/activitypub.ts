import { Hono } from 'hono';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../../lib/activitypub/crypto';
import { buildCreateActivity, buildNoteObject } from '../../lib/activitypub/note';
import { fetchActorPublicKey, verifyDigest, verifyHttpSignature } from '../../lib/activitypub/signature';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import type { Bindings, Variables } from '../types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Max accepted ActivityPub inbox body: activities are small JSON documents.
 * The declared Content-Length is checked first so oversized payloads are
 * rejected before the body is buffered.
 */
const MAX_INBOX_BODY_BYTES = 256 * 1024;

async function readInboxBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_INBOX_BODY_BYTES) return null;
  const text = await req.text();
  if (text.length > MAX_INBOX_BODY_BYTES) return null;
  return text;
}

async function checkInboxRateLimit(env: Bindings, req: Request): Promise<boolean> {
  return checkRateLimit(env.CACHE, `ap:inbox:${getClientIp(req)}`, { maxRequests: 60, windowSeconds: 60 });
}

/**
 * Replay fingerprint for an inbox delivery (#117): the same signed request
 * stays cryptographically valid for the ±30 minute Date window, so remember
 * recently seen (signature, date, digest) triples in KV for 35 minutes and
 * acknowledge repeats without re-queueing. KV failure fails open — replays
 * are then bounded by the signature window alone.
 */
async function inboxReplayKey(req: Request): Promise<string | null> {
  const sig = req.headers.get('Signature');
  const date = req.headers.get('Date');
  const digest = req.headers.get('Digest');
  if (!sig || !date || !digest) return null;
  try {
    const bytes = new TextEncoder().encode(`${sig}\n${date}\n${digest}`);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return `ap:replay:${Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;
  } catch {
    return null;
  }
}

// GET /.well-known/webfinger - WebFinger endpoint for ActivityPub discovery (first variant)
app.get('/.well-known/webfinger', async (c) => {
  try {
    const resource = c.req.query('resource');

    if (!resource) {
      return c.json({ error: 'Missing resource parameter' }, 400);
    }

    // Parse resource parameter: acct:username@domain
    const match = resource.match(/^acct:([^@]+)@(.+)$/);
    if (!match) {
      return c.json({ error: 'Invalid resource format' }, 400);
    }

    const [, username, domain] = match;
    if (!username) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Verify domain matches our BASE_URL
    const baseUrl = new URL(c.env.BASE_URL);
    if (domain !== baseUrl.hostname) {
      return c.json({ error: 'Domain mismatch' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Check if user exists (case-insensitive)
    const user = await c.env.DB.prepare('SELECT username FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Return WebFinger response
    const webfingerResponse = {
      subject: `acct:${username}@${domain}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: `${c.env.BASE_URL}/api/actors/${username}`,
        },
      ],
    };

    return c.json(webfingerResponse, 200, {
      'Content-Type': 'application/jrd+json',
    });
  } catch (error: unknown) {
    console.error('WebFinger error:', error);
    return c.json({ error: 'WebFinger failed' }, 500);
  }
});

// GET /api/actors/:username - ActivityPub Actor (Person) endpoint
app.get('/api/actors/:username', async (c) => {
  try {
    const username = c.req.param('username');
    const user = (await c.env.DB.prepare(
      `SELECT id, username, display_name, bio, avatar_key FROM users WHERE username = ? COLLATE NOCASE`,
    )
      .bind(username)
      .first()) as {
      id: string;
      username: string;
      display_name: string | null;
      bio: string | null;
      avatar_key: string | null;
    } | null;
    if (!user) return c.json({ error: 'User not found' }, 404);

    const keyRecord = (await c.env.DB.prepare(`SELECT public_key_pem FROM actor_keys WHERE user_id = ?`)
      .bind(user.id)
      .first()) as { public_key_pem: string } | null;
    let publicKeyPem = keyRecord?.public_key_pem;
    if (!publicKeyPem) {
      const keyPair = await generateKeyPair();
      publicKeyPem = await exportPublicKey(keyPair.publicKey);
      await c.env.DB.prepare(
        `INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
        .bind(user.id, publicKeyPem, await exportPrivateKey(keyPair.privateKey))
        .run();
    }

    const actorUrl = `${c.env.BASE_URL}/api/actors/${username}`;

    const actor: Record<string, unknown> = {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      type: 'Person',
      id: actorUrl,
      preferredUsername: user.username,
      name: user.display_name,
      summary: user.bio || '',
      url: `${c.env.BASE_URL}/users/${username}`,
      inbox: `${c.env.BASE_URL}/api/actors/${username}/inbox`,
      outbox: `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      followers: `${c.env.BASE_URL}/api/actors/${username}/followers`,
      following: `${c.env.BASE_URL}/api/actors/${username}/following`,
      publicKey: {
        id: `${actorUrl}#main-key`,
        owner: actorUrl,
        publicKeyPem: publicKeyPem,
      },
      endpoints: {
        sharedInbox: `${c.env.BASE_URL}/api/inbox`,
      },
    };

    if (user.avatar_key) {
      actor.icon = {
        type: 'Image',
        url: `${c.env.BASE_URL}/api/images/${user.avatar_key}`,
      };
    }

    return c.json(actor, 200, { 'Content-Type': 'application/activity+json' });
  } catch (error: unknown) {
    console.error('Actor endpoint error:', error);
    return c.json({ error: 'Actor endpoint failed' }, 500);
  }
});

// POST /api/actors/:username/inbox - ActivityPub inbox endpoint
app.post('/api/actors/:username/inbox', async (c) => {
  try {
    const username = c.req.param('username');
    const contentType = c.req.header('content-type') || '';

    if (!contentType.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400);
    }

    if (!(await checkInboxRateLimit(c.env, c.req.raw))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const targetUser = (await c.env.DB.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username)
      .first()) as { id: string; username: string } | null;

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const body = await readInboxBody(c.req.raw);
    if (body === null) {
      return c.json({ error: 'Inbox body too large' }, 413);
    }
    let activity: Record<string, unknown>;
    try {
      activity = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const actorId = activity.actor as string;
    if (!actorId || typeof actorId !== 'string') {
      return c.json({ error: 'Invalid actor' }, 400);
    }

    // Validate that the actor origin matches the keyId origin (H-5 fix)
    const signatureHeader = c.req.header('Signature');
    let keyIdOrigin: string | null = null;
    if (signatureHeader) {
      const keyIdMatch = signatureHeader.match(/keyId="([^"]+)"/);
      if (keyIdMatch) {
        try {
          keyIdOrigin = new URL(keyIdMatch[1]).origin;
          const actorOrigin = new URL(actorId).origin;
          if (keyIdOrigin !== actorOrigin) {
            console.error(`keyId origin ${keyIdOrigin} does not match actor origin ${actorOrigin}`);
            return c.json({ error: 'Invalid HTTP Signature: keyId/actor origin mismatch' }, 401);
          }
        } catch {
          return c.json({ error: 'Invalid keyId or actor URL' }, 400);
        }
      }
    }

    // Try to get local user's keys for signed fetch (authorized fetch support)
    let signKeyPem: string | undefined;
    let signKeyId: string | undefined;
    try {
      const keyRecord = (await c.env.DB.prepare(
        `SELECT ak.private_key_pem FROM actor_keys ak
         JOIN users u ON u.id = ak.user_id
         WHERE u.username = ? COLLATE NOCASE`,
      )
        .bind(username)
        .first()) as { private_key_pem: string } | null;
      if (keyRecord?.private_key_pem) {
        signKeyPem = keyRecord.private_key_pem;
        signKeyId = `${c.env.BASE_URL}/api/actors/${username}#main-key`;
      }
    } catch {
      // Proceed without signing
    }

    // Verify HTTP Signature (with signed fetch if keys available)
    const publicKeyPem = await fetchActorPublicKey(actorId, signKeyPem, signKeyId);
    if (!publicKeyPem) {
      return c.json({ error: 'Could not fetch actor public key' }, 401);
    }

    const sigValid = await verifyHttpSignature(c.req.raw, publicKeyPem);
    if (!sigValid) {
      return c.json({ error: 'Invalid HTTP Signature' }, 401);
    }

    const digestValid = await verifyDigest(c.req.raw, body);
    if (!digestValid) {
      return c.json({ error: 'Invalid Digest' }, 401);
    }

    // Queue for async processing
    if (c.env.AP_DELIVERY_QUEUE) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'inbox' as const,
        username,
        activity,
        actorId,
      });
    }

    return c.json({ ok: true }, 202);
  } catch (error: unknown) {
    console.error('Inbox error:', error);
    return c.json({ error: 'Inbox processing failed' }, 500);
  }
});

// Extract a local username from an actor URL, but only when the URL really
// points at this instance. startsWith(baseUrl) accepted look-alikes such as
// `https://flaxia.app@evil.example/actors/victim`, which let a remote actor
// address an arbitrary local user in to/cc/object.
function localActorUsername(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'string') return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(value);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const match = parsed.pathname.match(/^\/actors\/([^/]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

// POST /api/inbox - ActivityPub sharedInbox endpoint
app.post('/api/inbox', async (c) => {
  try {
    const contentType = c.req.header('content-type') || '';

    if (!contentType.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400);
    }

    if (!(await checkInboxRateLimit(c.env, c.req.raw))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await readInboxBody(c.req.raw);
    if (body === null) {
      return c.json({ error: 'Inbox body too large' }, 413);
    }
    let activity: Record<string, unknown>;
    try {
      activity = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const actorId = activity.actor as string;
    if (!actorId || typeof actorId !== 'string') {
      return c.json({ error: 'Invalid actor' }, 400);
    }

    // Validate that the actor origin matches the keyId origin (H-5 fix)
    const signatureHeader = c.req.header('Signature');
    if (signatureHeader) {
      const keyIdMatch = signatureHeader.match(/keyId="([^"]+)"/);
      if (keyIdMatch) {
        try {
          const keyIdOrigin = new URL(keyIdMatch[1]).origin;
          const actorOrigin = new URL(actorId).origin;
          if (keyIdOrigin !== actorOrigin) {
            console.error(`keyId origin ${keyIdOrigin} does not match actor origin ${actorOrigin}`);
            return c.json({ error: 'Invalid HTTP Signature: keyId/actor origin mismatch' }, 401);
          }
        } catch {
          return c.json({ error: 'Invalid keyId or actor URL' }, 400);
        }
      }
    }

    // Determine target username(s) from the activity
    const baseUrl = c.env.BASE_URL;

    // Try to get any local user's keys for signed fetch
    let signKeyPem: string | undefined;
    let signKeyId: string | undefined;
    try {
      const anyKey = (await c.env.DB.prepare(
        `SELECT ak.private_key_pem, u.username FROM actor_keys ak
         JOIN users u ON u.id = ak.user_id LIMIT 1`,
      ).first()) as { private_key_pem: string; username: string } | null;
      if (anyKey?.private_key_pem) {
        signKeyPem = anyKey.private_key_pem;
        signKeyId = `${c.env.BASE_URL}/api/actors/${anyKey.username}#main-key`;
      }
    } catch {
      // Proceed without signing
    }

    // Verify HTTP Signature (with signed fetch if keys available)
    const publicKeyPem = await fetchActorPublicKey(actorId, signKeyPem, signKeyId);
    if (!publicKeyPem) {
      return c.json({ error: 'Could not fetch actor public key' }, 401);
    }

    const sigValid = await verifyHttpSignature(c.req.raw, publicKeyPem);
    if (!sigValid) {
      return c.json({ error: 'Invalid HTTP Signature' }, 401);
    }

    const digestValid = await verifyDigest(c.req.raw, body);
    if (!digestValid) {
      return c.json({ error: 'Invalid Digest' }, 401);
    }

    // #117: drop exact replays of an already-accepted delivery instead of
    // re-queueing its fan-out a second time.
    const replayKey = await inboxReplayKey(c.req.raw);
    if (replayKey && c.env.CACHE) {
      try {
        if (await c.env.CACHE.get(replayKey)) {
          return c.json({ ok: true, duplicate: true }, 202);
        }
        await c.env.CACHE.put(replayKey, '1', { expirationTtl: 2100 });
      } catch {
        // fail open: bounded by the signature Date window alone
      }
    }
    // #117: bound the fan-out surface before expanding it. Only the first
    // entries are considered and only a handful of local targets are queued.
    const audienceValues: unknown[] = [
      ...(Array.isArray(activity.to) ? activity.to : activity.to ? [activity.to] : []),
      ...(Array.isArray(activity.cc) ? activity.cc : activity.cc ? [activity.cc] : []),
    ].slice(0, 50);
    const MAX_INBOX_TARGETS = 10;

    // Extract usernames from URLs that canonically point at local actors.
    const targetUsernames = new Set<string>();
    for (const value of audienceValues) {
      const username = localActorUsername(value, baseUrl);
      if (username) targetUsernames.add(username);
    }

    // If no local target found via to/cc, try the object field (for Follow
    // activities). It is held to the same canonical-origin rule.
    if (targetUsernames.size === 0) {
      const objectValue = activity.object as unknown;
      const candidate =
        typeof objectValue === 'string' ? objectValue : ((objectValue as { id?: unknown } | null)?.id ?? '');
      const username = localActorUsername(candidate, baseUrl);
      if (username) targetUsernames.add(username);
    }

    if (targetUsernames.size === 0) {
      console.error(
        JSON.stringify({
          event: 'sharedInbox:no_target_user',
          activityType: activity.type,
          actorId,
          activityId: (activity.id as string) || null,
          timestamp: new Date().toISOString(),
        }),
      );
      return c.json({ ok: true }, 202);
    }

    // Queue for async processing for each target, capped: one signed
    // activity must not fan out to an unbounded number of queue messages.
    if (c.env.AP_DELIVERY_QUEUE) {
      let queued = 0;
      for (const username of targetUsernames) {
        if (queued >= MAX_INBOX_TARGETS) break;
        await c.env.AP_DELIVERY_QUEUE.send({
          type: 'inbox' as const,
          username,
          activity,
          actorId,
        });
        queued++;
      }
    }

    return c.json({ ok: true }, 202);
  } catch (error: unknown) {
    console.error('sharedInbox error:', error);
    return c.json({ error: 'sharedInbox processing failed', details: (error as { message?: string })?.message }, 500);
  }
});

// GET /api/actors/:username/followers - ActivityPub Followers collection
app.get('/api/actors/:username/followers', async (c) => {
  try {
    const username = c.req.param('username');

    const user = (await c.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username)
      .first()) as { id: string } | null;

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const pageSize = 20;
    const pageParam = c.req.query('page');

    // Count local followers
    const localCount =
      (
        await c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?')
          .bind(user.id)
          .first<{ count: number }>()
      )?.count || 0;

    // Count remote followers
    const remoteCount =
      (
        await c.env.DB.prepare('SELECT COUNT(*) as count FROM ap_followers WHERE local_user_id = ?')
          .bind(user.id)
          .first<{ count: number }>()
      )?.count || 0;

    const totalItems = localCount + remoteCount;

    // If page parameter is present, return OrderedCollectionPage
    if (pageParam) {
      const pageNum = parseInt(pageParam, 10) || 1;
      const offset = (pageNum - 1) * pageSize;

      // Fetch local followers (users table via follows)
      const localFollowers = (await c.env.DB.prepare(`
        SELECT u.username FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.followee_id = ?
        ORDER BY u.username ASC LIMIT ? OFFSET ?
      `)
        .bind(user.id, pageSize, offset)
        .all()) as { results: Array<{ username: string }> };

      // If we still have room and it's the first page, also fetch remote followers
      const remoteFetched: Array<{ actor_url: string }> = [];
      if (localFollowers.results.length < pageSize) {
        const remoteOffset = Math.max(0, offset - localCount);
        const remaining = pageSize - localFollowers.results.length;
        const remoteFollowers = (await c.env.DB.prepare(`
          SELECT actor_url FROM ap_followers WHERE local_user_id = ?
          ORDER BY actor_url ASC LIMIT ? OFFSET ?
        `)
          .bind(user.id, remaining, remoteOffset)
          .all()) as { results: Array<{ actor_url: string }> };
        remoteFetched.push(...remoteFollowers.results);
      }

      const orderedItems = [
        ...localFollowers.results.map((f) => `${c.env.BASE_URL}/api/actors/${f.username}`),
        ...remoteFetched.map((f) => f.actor_url),
      ];

      const hasNext = offset + pageSize < totalItems;

      return c.json(
        {
          '@context': 'https://www.w3.org/ns/activitystreams',
          type: 'OrderedCollectionPage',
          id: `${c.env.BASE_URL}/api/actors/${username}/followers?page=${pageNum}`,
          partOf: `${c.env.BASE_URL}/api/actors/${username}/followers`,
          totalItems: totalItems,
          orderedItems: orderedItems,
          ...(hasNext && { next: `${c.env.BASE_URL}/api/actors/${username}/followers?page=${pageNum + 1}` }),
        },
        200,
        { 'Content-Type': 'application/activity+json' },
      );
    }

    return c.json(
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        id: `${c.env.BASE_URL}/api/actors/${username}/followers`,
        totalItems: totalItems,
        first: `${c.env.BASE_URL}/api/actors/${username}/followers?page=1`,
      },
      200,
      { 'Content-Type': 'application/activity+json' },
    );
  } catch (error: unknown) {
    console.error('Followers endpoint error:', error);
    return c.json({ error: 'Followers endpoint failed' }, 500);
  }
});

// GET /api/actors/:username/following - ActivityPub Following collection
app.get('/api/actors/:username/following', async (c) => {
  try {
    const username = c.req.param('username');

    const user = (await c.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username)
      .first()) as { id: string } | null;

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const pageSize = 20;
    const pageParam = c.req.query('page');

    // Count local following (remote following not counted here for simplicity)
    const totalCount =
      (
        await c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?')
          .bind(user.id)
          .first<{ count: number }>()
      )?.count || 0;

    // If page parameter is present, return OrderedCollectionPage
    if (pageParam) {
      const pageNum = parseInt(pageParam, 10) || 1;
      const offset = (pageNum - 1) * pageSize;

      const following = (await c.env.DB.prepare(`
        SELECT u.username FROM follows f
        JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ?
        ORDER BY u.username ASC LIMIT ? OFFSET ?
      `)
        .bind(user.id, pageSize, offset)
        .all()) as { results: Array<{ username: string }> };

      const orderedItems = following.results.map((f) => `${c.env.BASE_URL}/api/actors/${f.username}`);
      const hasNext = offset + pageSize < totalCount;

      return c.json(
        {
          '@context': 'https://www.w3.org/ns/activitystreams',
          type: 'OrderedCollectionPage',
          id: `${c.env.BASE_URL}/api/actors/${username}/following?page=${pageNum}`,
          partOf: `${c.env.BASE_URL}/api/actors/${username}/following`,
          totalItems: totalCount,
          orderedItems: orderedItems,
          ...(hasNext && { next: `${c.env.BASE_URL}/api/actors/${username}/following?page=${pageNum + 1}` }),
        },
        200,
        { 'Content-Type': 'application/activity+json' },
      );
    }

    return c.json(
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        id: `${c.env.BASE_URL}/api/actors/${username}/following`,
        totalItems: totalCount,
        first: `${c.env.BASE_URL}/api/actors/${username}/following?page=1`,
      },
      200,
      { 'Content-Type': 'application/activity+json' },
    );
  } catch (error: unknown) {
    console.error('Following endpoint error:', error);
    return c.json({ error: 'Following endpoint failed' }, 500);
  }
});

// GET /api/notes/:noteId - ActivityPub individual Note endpoint
app.get('/api/notes/:noteId', async (c) => {
  try {
    const noteId = c.req.param('noteId');

    if (!noteId) {
      return c.json({ error: 'Note ID required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get post with user info
    const post = (await c.env.DB.prepare(`
      SELECT p.id, p.text, p.created_at, p.status, p.user_id, p.username
      FROM posts p
      WHERE p.id = ? AND p.status = 'published'
    `)
      .bind(noteId)
      .first()) as {
      id: string;
      text: string;
      created_at: string;
      status: string;
      user_id: string;
      username: string;
    } | null;

    if (!post) {
      return c.json({ error: 'Note not found' }, 404);
    }

    // Get user info by username (posts store username, not user_id)
    const user = (await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE
    `)
      .bind(post.username)
      .first()) as { id: string; username: string; display_name: string } | null;

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Build Note object
    const note = buildNoteObject(
      {
        id: post.id,
        text: post.text,
        created_at: post.created_at,
        visibility: post.status === 'published' ? 'public' : 'private',
      },
      user,
      c.env.BASE_URL,
    );

    // Build Create activity wrapping the note
    const activity = buildCreateActivity(note, user, c.env.BASE_URL);

    return c.json(activity, 200, {
      'Content-Type': 'application/activity+json',
    });
  } catch (error: unknown) {
    console.error('Note endpoint error:', error);
    return c.json({ error: 'Note endpoint failed' }, 500);
  }
});

// GET /api/actors/:username/outbox - ActivityPub Outbox endpoint (paginated)
app.get('/api/actors/:username/outbox', async (c) => {
  try {
    const username = c.req.param('username');
    const page = c.req.query('page');
    const pageSize = 20;

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Find user in database
    const user = (await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first()) as { id: string; username: string; display_name: string } | null;

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Get total count of published posts
    const countResult = (await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM posts
      WHERE user_id = ? AND status = 'published'
    `)
      .bind(user.id)
      .first()) as { total: number };
    const totalItems = countResult?.total || 0;

    // If page parameter is present, return OrderedCollectionPage
    // Supports both ?page=true (legacy) and ?page=N (Mastodon-style)
    if (page !== null && page !== undefined) {
      let offsetNum = 0;
      if (page === 'true') {
        offsetNum = parseInt(c.req.query('offset') || '0', 10);
      } else {
        const pageNum = parseInt(page, 10) || 1;
        offsetNum = (pageNum - 1) * pageSize;
      }

      // Get posts for this page
      const posts = (await c.env.DB.prepare(`
        SELECT id, text, created_at, status FROM posts
        WHERE user_id = ? AND status = 'published'
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `)
        .bind(user.id, pageSize, offsetNum)
        .all()) as { results: Array<{ id: string; text: string; created_at: string; status: string }> };

      // Build activities from posts
      const activities = posts.results.map((post) => {
        const note = buildNoteObject(
          {
            ...post,
            visibility: post.status === 'published' ? 'public' : 'private',
          },
          user,
          c.env.BASE_URL,
        );
        return buildCreateActivity(note, user, c.env.BASE_URL);
      });

      const nextOffset = offsetNum + pageSize;
      const hasNext = nextOffset < totalItems;

      return c.json(
        {
          '@context': 'https://www.w3.org/ns/activitystreams',
          type: 'OrderedCollectionPage',
          id: `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${page}&offset=${offsetNum}`,
          partOf: `${c.env.BASE_URL}/api/actors/${username}/outbox`,
          totalItems: totalItems,
          orderedItems: activities,
          ...(hasNext && { next: `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${page}&offset=${nextOffset}` }),
        },
        200,
        { 'Content-Type': 'application/activity+json' },
      );
    }

    // Return main OrderedCollection with first link
    return c.json(
      {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        id: `${c.env.BASE_URL}/api/actors/${username}/outbox`,
        totalItems: totalItems,
        first: `${c.env.BASE_URL}/api/actors/${username}/outbox?page=1`,
      },
      200,
      { 'Content-Type': 'application/activity+json' },
    );
  } catch (error: unknown) {
    console.error('Outbox endpoint error:', error);
    return c.json({ error: 'Outbox endpoint failed' }, 500);
  }
});

// GET /notes/:noteId - ActivityPub individual Note endpoint (no /api prefix)
app.get('/notes/:noteId', async (c) => {
  try {
    const noteId = c.req.param('noteId');

    if (!noteId) {
      return c.json({ error: 'Note ID required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get post with user info
    const post = (await c.env.DB.prepare(`
      SELECT p.id, p.text, p.created_at, p.status, p.user_id, p.username
      FROM posts p
      WHERE p.id = ? AND p.status = 'published'
    `)
      .bind(noteId)
      .first()) as {
      id: string;
      text: string;
      created_at: string;
      status: string;
      user_id: string;
      username: string;
    } | null;

    if (!post) {
      return c.json({ error: 'Note not found' }, 404);
    }

    // Get user info by username (posts store username, not user_id)
    const user = (await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE
    `)
      .bind(post.username)
      .first()) as { id: string; username: string; display_name: string } | null;

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Build Note object
    const note = buildNoteObject(
      {
        id: post.id,
        text: post.text,
        created_at: post.created_at,
        visibility: post.status === 'published' ? 'public' : 'private',
      },
      user,
      c.env.BASE_URL,
    );

    // Build Create activity wrapping the note
    const activity = buildCreateActivity(note, user, c.env.BASE_URL);

    return c.json(activity, 200, {
      'Content-Type': 'application/activity+json',
    });
  } catch (error: unknown) {
    console.error('Note endpoint error:', error);
    return c.json({ error: 'Note endpoint failed' }, 500);
  }
});

// GET /.well-known/webfinger - WebFinger endpoint for ActivityPub discovery (second variant)
app.get('/.well-known/webfinger', async (c) => {
  try {
    const resource = c.req.query('resource');
    if (!resource || !resource.startsWith('acct:')) {
      return c.json({ error: 'Invalid resource parameter' }, 400);
    }

    // Extract username from acct:username@domain
    const match = resource.match(/^acct:([^@]+)@/);
    if (!match) {
      return c.json({ error: 'Invalid resource format' }, 400);
    }

    const username = match[1];
    if (!username) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Find user in database
    const user = await c.env.DB.prepare(`
      SELECT username FROM users 
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Return WebFinger response
    return c.json(
      {
        subject: resource,
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: `${c.env.BASE_URL}/api/actors/${username}`,
          },
        ],
      },
      200,
      {
        'Content-Type': 'application/jrd+json',
      },
    );
  } catch (error: unknown) {
    console.error('WebFinger error:', error);
    return c.json({ error: 'WebFinger failed' }, 500);
  }
});

export default app;
