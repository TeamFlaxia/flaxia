/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  type PostRow,
  renderHtmlShell,
  renderPersonJsonLd,
  renderPostList,
  renderProfileHeader,
  type UserRow,
} from '../../src/lib/render-html';
import { fetchActorPublicKey, verifyDigest, verifyHttpSignature } from '../lib/activitypub/signature';

type Bindings = {
  DB: D1Database;
  BASE_URL: string;
  AP_DELIVERY_QUEUE: Queue;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors());

const POST_SELECT = `
  SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key,
    p.text, p.hashtags, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key,
    p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
    COALESCE(p.reply_count, 0) as reply_count,
    COALESCE(p.impressions, 0) as impressions,
    p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth,
    COALESCE(p.status, 'published') as status,
    COALESCE(p.hidden, 0) as hidden, p.created_at
  FROM posts p
  LEFT JOIN users u ON p.user_id = u.id
`;

type RawUser = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_key: string | null;
  created_at: string;
};

type RawPost = Record<string, unknown>;

function toPost(row: RawPost): PostRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    username: String(row.username),
    display_name: row.display_name ? String(row.display_name) : null,
    avatar_key: row.avatar_key ? String(row.avatar_key) : null,
    text: String(row.text),
    hashtags: String(row.hashtags),
    gif_key: row.gif_key ? String(row.gif_key) : null,
    payload_key: row.payload_key ? String(row.payload_key) : null,
    swf_key: row.swf_key ? String(row.swf_key) : null,
    thumbnail_key: row.thumbnail_key ? String(row.thumbnail_key) : null,
    fresh_count: Number(row.fresh_count),
    bookmark_count: Number(row.bookmark_count),
    reply_count: Number(row.reply_count),
    impressions: Number(row.impressions),
    parent_id: row.parent_id ? String(row.parent_id) : null,
    root_id: row.root_id ? String(row.root_id) : null,
    depth: Number(row.depth),
    status: String(row.status),
    hidden: Number(row.hidden),
    created_at: String(row.created_at),
  };
}

// GET /users/:username
app.get('/', async (c) => {
  try {
    const url = new URL(c.req.url);
    const username = url.pathname.split('/users/')[1]?.split('/')[0] ?? '';
    const acceptHeader = c.req.header('Accept') || '';
    const baseUrl = c.env.BASE_URL ?? 'https://flaxia.app';

    if (!username) {
      return c.json({ error: 'Username required' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // If ActivityPub client, redirect to canonical actor URL
    if (acceptHeader.includes('application/activity+json')) {
      const verification = await c.env.DB.prepare(`
        SELECT id FROM users WHERE username = ? COLLATE NOCASE
      `)
        .bind(username)
        .first();
      if (!verification) {
        return c.json({ error: 'User not found' }, 404);
      }
      return c.redirect(`${c.env.BASE_URL}/api/actors/${username}`, 301);
    }

    const user = (await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, created_at
      FROM users
      WHERE username = ? COLLATE NOCASE
    `)
      .bind(username)
      .first()) as RawUser | null;

    if (!user) {
      const canonicalUrl = `${baseUrl}/users/${username}`;
      return c.html(
        renderHtmlShell(
          `<div class="ssr-empty"><h1>User not found</h1><p>The requested user does not exist.</p></div>`,
          { title: 'User not found', description: 'User not found', canonicalUrl },
        ),
        404,
      );
    }

    const canonicalUrl = `${baseUrl}/users/${user.username}`;
    const defaultImage = user.avatar_key ? `${baseUrl}/api/images/${user.avatar_key}` : `${baseUrl}/og-default-v2.png`;

    // Query recent posts
    const { results: postRows } = await c.env.DB.prepare(
      `${POST_SELECT} WHERE p.username = ? AND p.hidden = 0 AND p.status = 'published' ORDER BY p.created_at DESC LIMIT 20`,
    )
      .bind(username)
      .all<RawPost>();

    const posts = (postRows || []).map(toPost);

    // Query follower count
    const followerCount = (await c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?')
      .bind(user.id)
      .first()) as { count: number };
    const postCount = (await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND status = 'published' AND hidden = 0",
    )
      .bind(user.id)
      .first()) as { count: number };

    const jsonLd = renderPersonJsonLd(user as UserRow, canonicalUrl);

    const content = `
      ${renderProfileHeader(user as UserRow, baseUrl, postCount?.count || 0, followerCount?.count || 0)}
      <section>
        <h2 class="ssr-section-title">Posts</h2>
        ${renderPostList(posts, baseUrl)}
      </section>
      <footer class="ssr-footer">
        <a href="${baseUrl}">← Back to Flaxia</a>
      </footer>
    `;

    return c.html(
      renderHtmlShell(content, {
        title: `${user.display_name} (@${user.username}) - Flaxia`,
        description: user.bio ? user.bio.slice(0, 200) : `@${user.username}'s profile on Flaxia`,
        canonicalUrl,
        image: defaultImage,
        jsonLd,
      }),
    );
  } catch (error: unknown) {
    console.error('Get user error:', error);
    return c.json(
      { error: 'Failed to get user', details: (error as { message?: string })?.message || 'Unknown error' },
      500,
    );
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
    let activity: Record<string, unknown>;
    try {
      activity = JSON.parse(body) as Record<string, unknown>;
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
  } catch (error: unknown) {
    console.error('Inbox error:', error);
    return c.json(
      { error: 'Inbox processing failed', details: (error as { message?: string })?.message || 'Unknown error' },
      500,
    );
  }
});

export default app;
