/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchActorPublicKey, verifyDigest, verifyHttpSignature } from '../lib/activitypub/signature';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
  AP_DELIVERY_QUEUE: Queue;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors());

// GET /users/:username
app.get('/', async (c) => {
  try {
    const url = new URL(c.req.url);
    const username = url.pathname.split('/users/')[1]?.split('/')[0] ?? '';
    const acceptHeader = c.req.header('Accept') || '';

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const user = (await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, created_at
      FROM users
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first()) as any;

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // If ActivityPub client, redirect to canonical actor URL
    if (acceptHeader.includes('application/activity+json')) {
      return c.redirect(`${c.env.BASE_URL}/api/actors/${username}`, 301);
    }

    // Browser request - redirect to web profile page
    return c.redirect(`/users/${username}`);
  } catch (error: any) {
    console.error('Get user error:', error);
    return c.json({ error: 'Failed to get user', details: error?.message || 'Unknown error' }, 500);
  }
});

// POST /users/:username/inbox - ActivityPub inbox endpoint
app.post('/inbox', async (c) => {
  try {
    const contentType = c.req.header('content-type') || '';
    if (!contentType.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400);
    }

    const url = new URL(c.req.url);
    const username = url.pathname.split('/users/')[1]?.split('/inbox')[0] ?? '';

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const targetUser = (await c.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username)
      .first()) as { id: string } | null;

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const body = await c.req.text();
    let activity: any;
    try {
      activity = JSON.parse(body);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const actorId = activity.actor;
    if (!actorId || typeof actorId !== 'string') {
      return c.json({ error: 'Invalid actor' }, 400);
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
        signKeyId = `${c.env.BASE_URL}/actors/${username}#main-key`;
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
  } catch (error: any) {
    console.error('Inbox error:', error);
    return c.json({ error: 'Inbox processing failed', details: error?.message || 'Unknown error' }, 500);
  }
});

export default app;
