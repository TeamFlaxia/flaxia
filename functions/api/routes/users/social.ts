import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { buildFollowActivity, buildUndoActivity } from '../../../lib/activitypub/activities';
import { deliverToInbox } from '../../../lib/activitypub/delivery';
import { fetchFederationDocument, isPrivatePeerAllowed, resolveRemoteActor } from '../../../lib/activitypub/fetch';
import { actorPrivateKey, ensureActorKey } from '../../../lib/activitypub/keys';
import { enrichPostsWithAttachments } from '../../../lib/attachments.ts';
import { getMeWithSession, getSessionToken } from '../../../lib/auth';
import { clampLimit } from '../../../lib/pagination';
import { USER_TITLE_COLUMNS, USER_TITLE_JOIN } from '../../../lib/titles';
import { parsePublicHttpUrl, SsrfError } from '../../../lib/url-guard';
import { requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';
import { fetchRemoteJson } from './helpers.ts';

export const social = new Hono<{ Bindings: Bindings; Variables: Variables }>();

social.get('/users/suggestions', async (c) => {
  try {
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;

    if (!sessionData || !c.env.DB) {
      return c.json({ users: [] });
    }

    const currentUserId = sessionData.user.id;

    const pool = await c.env.DB.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, ${USER_TITLE_COLUMNS}
      FROM users u
      ${USER_TITLE_JOIN}
      WHERE u.id != ? AND u.frozen_at IS NULL
      AND u.id NOT IN (
        SELECT followee_id FROM follows WHERE follower_id = ?
      )
      ORDER BY u.id
      LIMIT 100
    `)
      .bind(currentUserId, currentUserId)
      .all();

    const poolArr = pool.results || [];
    const suggestions =
      poolArr.length <= 3
        ? poolArr
        : (() => {
            const shuffled = [...poolArr];
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled.slice(0, 3);
          })();

    return c.json({ users: suggestions });
  } catch (error: unknown) {
    console.error('User suggestions error:', error);
    return c.json({ users: [] });
  }
});

// POST /follows/:id - follow a user by ID (protected)
social.post('/follows/:id', requireAuth, async (c) => {
  try {
    const followeeId = c.req.param('id');

    if (!followeeId) {
      return c.json({ error: 'User ID required' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const followerId = user.id;

    if (followerId === followeeId) {
      return c.json({ error: 'Cannot follow yourself' }, 400);
    }

    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(followeeId).first();

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
      .bind(followerId, followeeId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Follow error:', error);
    return c.json({ error: 'Failed to follow user' }, 500);
  }
});

// POST /remote-follow - follow a remote ActivityPub user (protected)
social.post('/remote-follow', requireAuth, async (c) => {
  try {
    const { target } = (await c.req.json()) as { target?: string };
    if (!target || !target.includes('@')) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const [remoteUsername, domain] = target.split('@');
    if (!remoteUsername || !domain) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const localUser = user;

    // A remote instance is reached over https. An instance that runs next to
    // this one (the federation test peer) may serve plain http, but only when
    // it is on the list of allowed private peers.
    const origins = [`https://${domain}`];
    if (isPrivatePeerAllowed(c.env, domain)) origins.push(`http://${domain}`);

    // The key of the account signs the requests: an instance that runs in
    // secure mode only answers a signed request. The key is created when the
    // account federates for the first time.
    await ensureActorKey(c.env.DB, localUser.id);
    const privateKeyPem = await actorPrivateKey(c.env.DB, localUser.id);
    const signOptions = privateKeyPem
      ? {
          privateKeyPem,
          keyId: `${c.env.BASE_URL}/api/actors/${localUser.username}#main-key`,
        }
      : {};

    let wfData: { links?: Array<{ rel: string; href?: string; type?: string }> } | null = null;
    for (const origin of origins) {
      const webfingerUrl = `${origin}/.well-known/webfinger?resource=acct:${remoteUsername}@${domain}`;
      const response = await fetchFederationDocument(webfingerUrl, c.env, {
        headers: { Accept: 'application/jrd+json, application/json' },
        ...signOptions,
      });
      if (!response || !response.ok) continue;
      wfData = (await response.json()) as { links?: Array<{ rel: string; href?: string; type?: string }> };
      break;
    }

    if (!wfData) {
      return c.json({ error: 'Could not resolve remote user' }, 404);
    }
    const selfLink = wfData.links?.find((l: { rel: string }) => l.rel === 'self');
    if (!selfLink?.href) {
      return c.json({ error: 'Remote user has no ActivityPub actor link' }, 400);
    }

    // The actor document is the source of truth for the inbox: it is only
    // accepted when it lives on the same origin as the actor and when it
    // points at a public inbox.
    const actor = await resolveRemoteActor(selfLink.href, c.env, signOptions);
    if (!actor) {
      return c.json({ error: 'Could not fetch remote actor' }, 404);
    }
    const actorUrl = actor.actorUrl;
    const inboxUrl = actor.inbox;

    const existing = await c.env.DB.prepare(
      'SELECT id FROM ap_following WHERE local_user_id = ? AND target_actor_url = ?',
    )
      .bind(localUser.id, actorUrl)
      .first();

    if (existing) {
      return c.json({ error: 'Already following this user' }, 409);
    }

    const followId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, shared_inbox_url, target_username, target_domain, display_name, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `)
      .bind(followId, localUser.id, actorUrl, inboxUrl, actor.sharedInbox, remoteUsername, domain, actor.displayName)
      .run();

    // Remember the actor document so later deliveries do not have to fetch
    // it again.
    await c.env.DB.prepare(`
      INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, public_key_pem, preferred_username, display_name, icon_url, domain, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(actor_url) DO UPDATE SET
        inbox_url = excluded.inbox_url,
        shared_inbox_url = excluded.shared_inbox_url,
        public_key_pem = excluded.public_key_pem,
        preferred_username = excluded.preferred_username,
        display_name = excluded.display_name,
        icon_url = excluded.icon_url,
        domain = excluded.domain,
        fetched_at = excluded.fetched_at
    `)
      .bind(
        actor.actorUrl,
        actor.inbox,
        actor.sharedInbox,
        actor.publicKeyPem,
        actor.preferredUsername,
        actor.displayName,
        actor.iconUrl,
        actor.domain,
      )
      .run();

    const followActivity = buildFollowActivity(c.env.BASE_URL, localUser.username, actorUrl, followId);

    await deliverToInbox(c.env, {
      inboxUrl,
      username: localUser.username,
      activity: followActivity,
    });

    await c.env.DB.prepare('UPDATE ap_following SET status = ? WHERE id = ?').bind('sent', followId).run();

    return c.json({
      following: true,
      target: target,
      status: 'pending',
      message: 'Follow request sent to remote user',
    });
  } catch (error: unknown) {
    console.error('Remote follow error:', error);
    return c.json({ error: 'Failed to follow remote user' }, 500);
  }
});

// DELETE /remote-follow - unfollow a remote ActivityPub user (protected)
social.delete('/remote-follow', requireAuth, async (c) => {
  try {
    const { target } = (await c.req.json()) as { target?: string };
    if (!target || !target.includes('@')) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const [remoteUsername, domain] = target.split('@');
    if (!remoteUsername || !domain) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const localUser = user;

    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${remoteUsername}@${domain}`;
    let wfResponse: Response;
    let actorUrl: string;
    try {
      const wfResult = await fetchRemoteJson(webfingerUrl, 'application/jrd+json, application/json');
      wfResponse = wfResult.response;
    } catch (error: unknown) {
      if (error instanceof SsrfError) return c.json({ error: 'Invalid target domain' }, 400);
      throw error;
    }

    if (!wfResponse.ok) {
      return c.json({ error: 'Could not resolve remote user' }, 404);
    }

    const wfData = (await wfResponse.json()) as { links?: Array<{ rel: string; href?: string; type?: string }> };
    const selfLink = wfData.links?.find((l: { rel: string }) => l.rel === 'self');
    if (!selfLink?.href) {
      return c.json({ error: 'Remote user has no ActivityPub actor link' }, 400);
    }

    try {
      actorUrl = parsePublicHttpUrl(selfLink.href).toString();
    } catch {
      return c.json({ error: 'Remote user has an invalid actor URL' }, 400);
    }

    const following = (await c.env.DB.prepare(
      'SELECT id, target_inbox_url FROM ap_following WHERE local_user_id = ? AND target_actor_url = ?',
    )
      .bind(localUser.id, actorUrl)
      .first()) as { id: string; target_inbox_url: string } | null;

    if (!following) {
      return c.json({ error: 'Not following this user' }, 404);
    }

    await c.env.DB.prepare('DELETE FROM ap_following WHERE id = ?').bind(following.id).run();

    const followActivity = buildFollowActivity(c.env.BASE_URL, localUser.username, actorUrl, following.id);
    const undoActivity = buildUndoActivity(c.env.BASE_URL, localUser.username, followActivity, following.id, {
      to: [actorUrl],
    });

    if (following.target_inbox_url) {
      await deliverToInbox(c.env, {
        inboxUrl: following.target_inbox_url,
        username: localUser.username,
        activity: undoActivity,
      });
    }

    return c.json({
      following: false,
      target: target,
      message: 'Unfollow request sent to remote user',
    });
  } catch (error: unknown) {
    console.error('Remote unfollow error:', error);
    return c.json({ error: 'Failed to unfollow remote user' }, 500);
  }
});

// GET /remote/actors/:domain/:username - the profile of an account of another instance
social.get('/remote/actors/:domain/:username', async (c) => {
  const domain = c.req.param('domain');
  const username = c.req.param('username');
  if (!domain || !username) {
    return c.json({ error: 'Missing account' }, 400);
  }

  const actor = await c.env.DB.prepare(
    `SELECT actor_url, preferred_username, display_name, icon_url, domain, inbox_url
     FROM ap_actors WHERE domain = ? AND preferred_username = ? LIMIT 1`,
  )
    .bind(domain.toLowerCase(), username)
    .first<{
      actor_url: string;
      preferred_username: string | null;
      display_name: string | null;
      icon_url: string | null;
      domain: string | null;
      inbox_url: string | null;
    }>();

  if (!actor) {
    return c.json({ error: 'Remote account not found' }, 404);
  }

  // Whether the account that is signed in follows this account.
  const user = c.get('user');
  let following = false;
  let followState: string | null = null;
  if (user) {
    const state = await c.env.DB.prepare(
      'SELECT status FROM ap_following WHERE local_user_id = ? AND target_actor_url = ? LIMIT 1',
    )
      .bind(user.id, actor.actor_url)
      .first<{ status: string }>();
    followState = state?.status ?? null;
    following = followState === 'accepted';
  }

  const posts = await c.env.DB.prepare(
    `SELECT id, text, created_at, fresh_count, reload_count, reply_count, ap_object_id
     FROM posts WHERE actor_id = ? AND status = 'published' AND hidden = 0
     ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(actor.actor_url)
    .all<{
      id: string;
      text: string;
      created_at: string;
      fresh_count: number;
      reload_count: number;
      reply_count: number;
      ap_object_id: string | null;
    }>();

  await enrichPostsWithAttachments(posts.results ?? [], c.env.DB);

  return c.json({
    actor: {
      actor_url: actor.actor_url,
      preferred_username: actor.preferred_username,
      display_name: actor.display_name,
      icon_url: actor.icon_url,
      domain: actor.domain,
      inbox_url: actor.inbox_url,
    },
    following,
    follow_state: followState,
    posts: posts.results ?? [],
  });
});

// GET /users/suggest?q=prefix - suggest usernames matching prefix
social.get('/users/suggest', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q || q.length < 1) {
      return c.json({ users: [] });
    }

    const limit = clampLimit(c.req.query('limit'), 10, 20);
    const prefix = q.toLowerCase();

    const result = await c.env.DB.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, ${USER_TITLE_COLUMNS}
      FROM users u
      ${USER_TITLE_JOIN}
      WHERE u.frozen_at IS NULL AND (LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ?)
      ORDER BY
        CASE WHEN LOWER(u.username) LIKE ? THEN 0 ELSE 1 END,
        u.created_at DESC
      LIMIT ?
    `)
      .bind(prefix + '%', prefix + '%', prefix + '%', limit)
      .all();

    const usersList = (result.results || []).map((u: Record<string, unknown>) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name || '',
      avatar_key: u.avatar_key || '',
      badge_type: (u.badge_type as string | null) ?? null,
      name_color: (u.name_color as string | null) ?? null,
      equipped_title_id: (u.equipped_title_id as string | null) ?? null,
      title_name: (u.title_name as string | null) ?? null,
      title_name_ja: (u.title_name_ja as string | null) ?? null,
      title_description: (u.title_description as string | null) ?? null,
      title_description_ja: (u.title_description_ja as string | null) ?? null,
      title_icon: (u.title_icon as string | null) ?? null,
    }));

    return c.json({ users: usersList }, 200, {
      'Cache-Control': 'public, max-age=15',
    });
  } catch (error: unknown) {
    console.error('User suggest error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /users/:username - get public user profile
