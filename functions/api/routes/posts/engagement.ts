import { type Context, Hono } from 'hono';
import { nanoid } from 'nanoid';
import { buildLikeActivity, buildUndoActivity } from '../../../lib/activitypub/activities';
import { enrichPostsWithRemoteAuthors } from '../../../lib/activitypub/authors';
import { deliverToActorInbox, deliverToFollowers } from '../../../lib/activitypub/delivery';
import { enrichPostsWithAttachments } from '../../../lib/attachments';
import { sendPushToAll, waitUntil } from '../../../lib/notify';
import { clampLimit } from '../../../lib/pagination';
import { enrichPostsWithQuotes, enrichPostsWithReactions } from '../../feed-enrichment';
import { requireAuth } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';
import { ensureReactionsTable, visibilityFilter } from './helpers.ts';

export const engagement = new Hono<{ Bindings: Bindings; Variables: Variables }>();

engagement.post('/posts/:id/fresh', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user')?.id || '';
  const currentUser = c.get('user');

  // Get post to check ownership for notification and remote actor
  const post = (await c.env.DB.prepare(
    "SELECT id, user_id, actor_id, username, text, ap_object_id FROM posts WHERE id = ? AND status = 'published'",
  )
    .bind(postId)
    .first()) as {
    id: string;
    user_id: string;
    actor_id: string | null;
    username: string;
    text: string;
    ap_object_id: string | null;
  } | null;

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  // Check if already freshed
  const existing = await c.env.DB.prepare('SELECT * FROM freshs WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId)
    .first();

  if (existing) {
    // Remove fresh
    await c.env.DB.prepare('DELETE FROM freshs WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = MAX(0, fresh_count - 1), engagement_hotness = engagement_hotness - 2.0 WHERE id = ? RETURNING fresh_count',
    )
      .bind(postId)
      .first<{ fresh_count: number }>();

    // The like of a post of another instance is retracted there as well.
    if (currentUser) deliverFreshLike(c, post, currentUser.username, 'remove');

    return c.json({ freshed: false, is_freshed: false, fresh_count: result?.fresh_count ?? 0 });
  } else {
    // Add fresh
    await c.env.DB.prepare('INSERT INTO freshs (post_id, user_id, created_at) VALUES (?, ?, ?)')
      .bind(postId, userId, new Date().toISOString())
      .run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count + 1, engagement_hotness = engagement_hotness + 2.0 WHERE id = ? RETURNING fresh_count',
    )
      .bind(postId)
      .first<{ fresh_count: number }>();

    // Create notification for post author (only if not self-freshing)
    if (post.user_id !== userId) {
      try {
        const existingNotif = (await c.env.DB.prepare(
          "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'fresh' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(post.user_id, postId)
          .first()) as Record<string, unknown>;

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data as string)
            : existingNotif.actor_id
              ? [existingNotif.actor_id as string]
              : [];
          if (!actorData.includes(userId)) {
            actorData.push(userId);
          }
          await c.env.DB.prepare(
            "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
          )
            .bind(actorData[0], JSON.stringify(actorData), existingNotif.id as string)
            .run();
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(nanoid(), post.user_id, 'fresh', postId, userId)
            .run();
          {
            const actor = c.get('user');

            const textPreview = ((post as Record<string, unknown>).text as string) || '';
            waitUntil(
              c,
              () =>
                sendPushToAll(c.env, post.user_id, 'fresh', actor?.username, actor?.display_name, textPreview, postId),
              'Failed to send fresh push',
            );
          }
        }
      } catch (e) {
        console.error('Failed to create fresh notification:', e);
      }
    }

    // A post of another instance is liked on the instance that published it:
    // the activity has to reference the object id of that note, not a note
    // URL of this instance.
    if (currentUser) deliverFreshLike(c, post, currentUser.username, 'add');

    return c.json({ freshed: true, is_freshed: true, fresh_count: result?.fresh_count ?? 0 });
  }
});

// POST /api/posts/:id/bookmark - toggle bookmark (protected)
engagement.post('/posts/:id/bookmark', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user')?.id || '';

  const v = visibilityFilter(userId);
  const post = (await c.env.DB.prepare(`SELECT p.id FROM posts p WHERE p.id = ? AND p.status = 'published' ${v.sql}`)
    .bind(postId, ...v.params)
    .first()) as { id: string } | null;

  if (!post) {
    return c.json({ error: 'Post not found' }, 404);
  }

  // Check if already bookmarked
  const existing = await c.env.DB.prepare('SELECT * FROM bookmarks WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId)
    .first();

  if (existing) {
    await c.env.DB.prepare('DELETE FROM bookmarks WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count - 1 WHERE id = ? RETURNING bookmark_count',
    )
      .bind(postId)
      .first<{ bookmark_count: number }>();

    return c.json({ bookmarked: false, is_bookmarked: false, bookmark_count: result?.bookmark_count ?? 0 });
  } else {
    await c.env.DB.prepare('INSERT INTO bookmarks (post_id, user_id) VALUES (?, ?)').bind(postId, userId).run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = ? RETURNING bookmark_count',
    )
      .bind(postId)
      .first<{ bookmark_count: number }>();

    return c.json({ bookmarked: true, is_bookmarked: true, bookmark_count: result?.bookmark_count ?? 0 });
  }
});

// POST /api/posts/:id/reactions - toggle an emoji reaction on a post (protected)
engagement.post('/posts/:id/reactions', requireAuth, async (c) => {
  try {
    await ensureReactionsTable(c.env.DB);
    const postId = c.req.param('id');
    const userId = c.get('user')?.id || '';
    const { emoji } = (await c.req.json()) as { emoji?: string };

    if (typeof emoji !== 'string' || emoji.trim().length === 0) {
      return c.json({ error: 'Invalid emoji' }, 400);
    }
    const cleanEmoji = emoji.trim();
    if (cleanEmoji.length > 32) {
      return c.json({ error: 'Emoji too long' }, 400);
    }

    const v = visibilityFilter(userId);
    const post = (await c.env.DB.prepare(`SELECT p.id FROM posts p WHERE p.id = ? AND p.status = 'published' ${v.sql}`)
      .bind(postId, ...v.params)
      .first()) as { id: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const existing = await c.env.DB.prepare('SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
      .bind(postId, userId, cleanEmoji)
      .first();

    if (existing) {
      await c.env.DB.prepare('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
        .bind(postId, userId, cleanEmoji)
        .run();
    } else {
      await c.env.DB.prepare('INSERT INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)')
        .bind(postId, userId, cleanEmoji)
        .run();
    }

    const postRow = { id: postId } as PostRow;
    await enrichPostsWithReactions([postRow], c.env.DB, userId);

    return c.json({
      emoji: cleanEmoji,
      reacted: !existing,
      reactions: postRow.reactions || [],
    });
  } catch (error: unknown) {
    console.error('Reaction toggle error:', error);
    return c.json({ error: 'Failed to toggle reaction' }, 500);
  }
});

// GET /api/bookmarks - get bookmarked posts for current user (protected)
engagement.get('/bookmarks', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = clampLimit(c.req.query('limit'), 20, 50);
    const userId = c.get('user')?.id || '';
    const visibility = visibilityFilter(userId);

    let query: string;
    const params: Array<unknown> = [userId];

    if (cursor) {
      params.push(cursor);
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ? ${visibility.sql}
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(...visibility.params, limit);
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 ${visibility.sql}
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(...visibility.params, limit);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const posts = result.results || [];

    // All posts fetched from bookmarks are by definition bookmarked
    posts.forEach((post: Record<string, unknown>) => {
      post.is_bookmarked = true;
    });

    if (posts.length > 0) {
      const postIds = posts.map((post: Record<string, unknown>) => post.id);
      const reloadResult = await c.env.DB.prepare(
        `SELECT post_id FROM shares WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
      )
        .bind(userId, ...postIds)
        .all<{ post_id: string }>();
      const reloaded = new Set((reloadResult.results || []).map((row) => row.post_id));
      posts.forEach((post: Record<string, unknown>) => {
        post.is_reloaded = reloaded.has(post.id as string);
      });
    }

    await enrichPostsWithQuotes(posts as PostRow[], c.env.DB, userId);
    await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, userId);
    await enrichPostsWithRemoteAuthors(posts as Array<Record<string, unknown>>, c.env.DB);

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;

    return c.json({ posts, nextCursor });
  } catch (error: unknown) {
    console.error('Bookmarks fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/freshs - get current user's Freshed (liked) posts (protected)
engagement.get('/freshs', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor');
    const limit = clampLimit(c.req.query('limit'), 20, 50);
    const userId = c.get('user')?.id || '';
    const visibility = visibilityFilter(userId);

    let query: string;
    const params: Array<unknown> = [userId];

    if (cursor) {
      params.push(cursor);
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
        INNER JOIN freshs f ON f.post_id = p.id AND f.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ? ${visibility.sql}
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(...visibility.params, limit);
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
        INNER JOIN freshs f ON f.post_id = p.id AND f.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 ${visibility.sql}
        ORDER BY p.created_at DESC
        LIMIT ?
      `;
      params.push(...visibility.params, limit);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();
    const posts = result.results || [];

    // All posts fetched here are by definition freshed by the current user
    posts.forEach((post: Record<string, unknown>) => {
      post.is_freshed = true;
    });

    // Enrich bookmark state for these posts
    if (posts.length > 0) {
      const postIds = posts.map((p: Record<string, unknown>) => p.id);
      const bmResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
      )
        .bind(userId, ...postIds)
        .all<{ post_id: string }>();
      const bookmarked = new Set((bmResult.results || []).map((r) => r.post_id));
      posts.forEach((post: Record<string, unknown>) => {
        post.is_bookmarked = bookmarked.has(post.id as string);
      });

      const reloadResult = await c.env.DB.prepare(
        `SELECT post_id FROM shares WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
      )
        .bind(userId, ...postIds)
        .all<{ post_id: string }>();
      const reloaded = new Set((reloadResult.results || []).map((r) => r.post_id));
      posts.forEach((post: Record<string, unknown>) => {
        post.is_reloaded = reloaded.has(post.id as string);
      });
    }

    await enrichPostsWithReactions(posts as PostRow[], c.env.DB, userId);
    await enrichPostsWithAttachments(posts as PostRow[], c.env.DB);
    await enrichPostsWithRemoteAuthors(posts as Array<Record<string, unknown>>, c.env.DB);

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null;

    return c.json({ posts, nextCursor });
  } catch (error: unknown) {
    console.error('Freshs fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/posts/fresh/batch - batch toggle Fresh! for multiple posts (protected)
engagement.post('/posts/fresh/batch', requireAuth, async (c) => {
  try {
    const { post_ids, action } = await c.req.json();

    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return c.json({ error: 'Invalid post_ids array' }, 400);
    }

    if (!['add', 'remove'].includes(action)) {
      return c.json({ error: 'Invalid action. Must be "add" or "remove"' }, 400);
    }

    const userId = c.get('user')?.id || '';
    const currentUser = c.get('user');
    const maxBatchSize = 50;

    if (post_ids.length > maxBatchSize) {
      return c.json({ error: `Maximum batch size is ${maxBatchSize}` }, 400);
    }

    // Get posts to check ownership for notifications and to address the
    // ActivityPub Like/Undo to the original author of a remote note.
    const posts = await c.env.DB.prepare(`
      SELECT id, user_id, actor_id, ap_object_id FROM posts WHERE id IN (${post_ids.map(() => '?').join(',')}) AND status = 'published' AND hidden = 0
    `)
      .bind(...post_ids)
      .all();

    const validPostIds = posts.results?.map((p) => p.id) || [];
    const invalidIds = post_ids.filter((id) => !validPostIds.includes(id));

    if (invalidIds.length > 0) {
      return c.json({ error: 'Some posts not found', invalid_ids: invalidIds }, 404);
    }

    if (action === 'add') {
      // Check which posts are already freshed to avoid duplicates
      const existingFreshes = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(userId, ...post_ids)
        .all();

      const alreadyFreshed = new Set(existingFreshes.results?.map((f) => f.post_id) || []);
      const toFresh = post_ids.filter((id) => !alreadyFreshed.has(id));

      if (toFresh.length > 0) {
        // Batch insert freshs
        const stmts = toFresh.map((id) =>
          c.env.DB.prepare('INSERT INTO freshs (post_id, user_id, created_at) VALUES (?, ?, ?)').bind(
            id,
            userId,
            new Date().toISOString(),
          ),
        );
        await c.env.DB.batch(stmts);

        // Batch update fresh counts
        await c.env.DB.prepare(`
          UPDATE posts SET fresh_count = fresh_count + 1, engagement_hotness = engagement_hotness + 2.0 WHERE id IN (${toFresh.map(() => '?').join(',')})
        `)
          .bind(...toFresh)
          .run();

        // Create notifications for non-self posts (grouped)
        const nonSelfPosts = posts.results.filter((p) => toFresh.includes(p.id) && p.user_id !== userId);

        if (nonSelfPosts.length > 0) {
          try {
            // Get existing fresh notifications for these posts
            const userPostPairs = nonSelfPosts.map((p) => ({ userId: p.user_id, postId: p.id }));
            const existingNotifs = await c.env.DB.prepare(`
              SELECT id, user_id, post_id, actor_id, actor_data FROM notifications 
              WHERE (user_id, post_id) IN (${userPostPairs.map(() => '(?, ?)').join(',')}) AND type = 'fresh'
            `)
              .bind(...userPostPairs.flatMap((p) => [p.userId, p.postId]))
              .all();

            const existingMap = new Map<string, Record<string, unknown>>();
            for (const row of existingNotifs.results || []) {
              existingMap.set(`${row.user_id}:${row.post_id}`, row);
            }

            const inserts: Array<[string, string, string, string, string]> = [];
            const updates: Array<{ stmt: ReturnType<typeof c.env.DB.prepare>; params: unknown[] }> = [];

            for (const p of nonSelfPosts) {
              const key = `${p.user_id}:${p.id}`;
              const existing = existingMap.get(key);

              if (existing) {
                const actorData = existing.actor_data
                  ? JSON.parse(existing.actor_data as string)
                  : existing.actor_id
                    ? [existing.actor_id as string]
                    : [];
                if (!actorData.includes(userId)) {
                  actorData.push(userId);
                }
                updates.push({
                  stmt: c.env.DB.prepare(
                    "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
                  ),
                  params: [actorData[0], JSON.stringify(actorData), existing.id as string],
                });
              } else {
                inserts.push([nanoid(), String(p.user_id), 'fresh', String(p.id), userId]);
              }
            }

            // Batch all notification updates and inserts
            const batchStmts: Array<ReturnType<typeof c.env.DB.prepare>> = [];
            for (const update of updates) {
              batchStmts.push(update.stmt.bind(...update.params));
            }
            if (inserts.length > 0) {
              for (const row of inserts) {
                batchStmts.push(
                  c.env.DB.prepare(
                    'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                  ).bind(...row),
                );
              }
            }
            if (batchStmts.length > 0) {
              await c.env.DB.batch(batchStmts);
            }
          } catch (e) {
            console.error('Failed to create batch fresh notifications:', e);
          }
        }

        // One Like per freshly liked remote post, delivered to its author.
        // A Set makes a repeated id in the request still produce one delivery.
        if (currentUser) {
          const postById = new Map<string, FederatedPost>(
            (posts.results ?? []).map((p) => [p.id as string, p as unknown as FederatedPost]),
          );
          for (const id of new Set(toFresh as string[])) {
            const post = postById.get(id);
            if (post) deliverFreshLike(c, post, currentUser.username, 'add');
          }
        }
      }

      return c.json({ freshed: toFresh, already_freshed: Array.from(alreadyFreshed) });
    } else {
      // Remove freshes — only for posts the caller had actually freshed. The
      // previous version decremented every listed post, letting any account
      // drive other users' counters negative.
      const existingFreshes = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `)
        .bind(userId, ...post_ids)
        .all();

      const actuallyFreshed = (existingFreshes.results?.map((f) => f.post_id) || []) as string[];

      if (actuallyFreshed.length > 0) {
        await c.env.DB.prepare(`
          DELETE FROM freshs WHERE user_id = ? AND post_id IN (${actuallyFreshed.map(() => '?').join(',')})
        `)
          .bind(userId, ...actuallyFreshed)
          .run();

        // Clamp at zero so counters cannot go negative.
        await c.env.DB.prepare(`
          UPDATE posts SET fresh_count = MAX(fresh_count - 1, 0), engagement_hotness = MAX(engagement_hotness - 2.0, 0) WHERE id IN (${actuallyFreshed.map(() => '?').join(',')})
        `)
          .bind(...actuallyFreshed)
          .run();

        // Retract the Like on each remote post whose Fresh was removed.
        if (currentUser) {
          const postById = new Map<string, FederatedPost>(
            (posts.results ?? []).map((p) => [p.id as string, p as unknown as FederatedPost]),
          );
          for (const id of new Set(actuallyFreshed)) {
            const post = postById.get(id);
            if (post) deliverFreshLike(c, post, currentUser.username, 'remove');
          }
        }
      }

      return c.json({ unfreshed: post_ids });
    }
  } catch (error: unknown) {
    console.error('Batch fresh error:', error);
    return c.json({ error: 'Batch fresh operation failed' }, 500);
  }
});

type PostsContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/** Post columns needed to address a Like to the right object and inbox. */
type FederatedPost = {
  id: string;
  actor_id: string | null;
  ap_object_id: string | null;
};

/**
 * ActivityPub object id of a post. Mirrored remote posts keep the id they were
 * published with; local posts are addressed by their canonical note URL.
 */
function engagementObjectUrl(baseUrl: string, post: FederatedPost): string {
  return post.ap_object_id ?? `${baseUrl}/api/notes/${post.id}`;
}

/**
 * Queue a Like (or its Undo) for the author of a remote post.
 *
 * Only mirrored remote posts carry an `actor_id`, i.e. an inbox that can
 * receive the Like; a purely local post has no remote author to notify. Callers
 * pass at most one entry per post, so a batch produces exactly one activity per
 * post. Delivery is always scheduled with `waitUntil` and never awaited on the
 * request's critical path.
 */
function deliverFreshLike(c: PostsContext, post: FederatedPost, username: string, action: 'add' | 'remove'): void {
  const actorUrl = post.actor_id;
  if (!actorUrl) return;
  const like = buildLikeActivity(c.env.BASE_URL, username, engagementObjectUrl(c.env.BASE_URL, post), nanoid());
  const activity = action === 'add' ? like : buildUndoActivity(c.env.BASE_URL, username, like, nanoid());
  waitUntil(
    c,
    () => deliverToActorInbox(c.env, { actorUrl, username, activity }),
    `Failed to deliver ${activity.type} to remote actor`,
  );
}

/**
 * Delivers a reload Announce/Undo to the reloading user's federated followers
 * and, for remote posts, to the original author's inbox.
 */
function deliverReloadActivity(
  c: PostsContext,
  post: { actor_id: string | null },
  currentUser: { id: string; username: string },
  activity: Record<string, unknown>,
): void {
  const actorUrl = post.actor_id;
  waitUntil(
    c,
    async () => {
      try {
        await deliverToFollowers(c.env, {
          userId: currentUser.id,
          username: currentUser.username,
          activity,
        });
      } catch (e) {
        console.error('Failed to deliver reload activity to followers:', e);
      }

      if (actorUrl) {
        try {
          await deliverToActorInbox(c.env, { actorUrl, username: currentUser.username, activity });
        } catch (e) {
          console.error('Failed to deliver reload activity to remote actor:', e);
        }
      }
    },
    'Failed to deliver reload activity',
  );
}

// POST /api/posts/:id/reload - toggle reload (retweet, protected)
const toggleReload = async (c: PostsContext, legacyAlias = false) => {
  try {
    const postId = c.req.param('id');
    const currentUser = c.get('user');
    if (!currentUser) return c.json({ error: 'Unauthorized' }, 401);

    const post = (await c.env.DB.prepare(
      "SELECT id, user_id, actor_id, ap_object_id, username, text FROM posts WHERE id = ? AND status = 'published' AND hidden = 0",
    )
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      actor_id: string | null;
      ap_object_id: string | null;
      username: string;
      text: string;
    } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const existing = (await c.env.DB.prepare('SELECT id FROM shares WHERE post_id = ? AND user_id = ?')
      .bind(postId, currentUser.id)
      .first()) as { id: string } | null;

    const actorUrl = `${c.env.BASE_URL}/api/actors/${currentUser.username}`;
    // A post of another instance is announced with the object id of that
    // note: a note URL of this instance does not exist for it.
    const noteUrl = post.ap_object_id ?? `${c.env.BASE_URL}/api/notes/${postId}`;
    const publicAudience = 'https://www.w3.org/ns/activitystreams#Public';

    if (existing) {
      await c.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(existing.id).run();

      const result = await c.env.DB.prepare(
        'UPDATE posts SET reload_count = MAX(0, reload_count - 1), engagement_hotness = MAX(0.0, engagement_hotness - 3.0) WHERE id = ? RETURNING reload_count',
      )
        .bind(postId)
        .first<{ reload_count: number }>();

      const announce = {
        id: `${c.env.BASE_URL}/activities/announce-${existing.id}`,
        type: 'Announce',
        actor: actorUrl,
        object: noteUrl,
        to: [publicAudience],
        cc: [`${c.env.BASE_URL}/api/actors/${currentUser.username}/followers`],
      };
      deliverReloadActivity(c, post, currentUser, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${c.env.BASE_URL}/activities/undo-announce-${existing.id}`,
        type: 'Undo',
        actor: actorUrl,
        object: announce,
        to: announce.to,
        cc: announce.cc,
      });

      const response = { reloaded: false, is_reloaded: false, reload_count: result?.reload_count ?? 0 };
      return c.json(legacyAlias ? { ...response, shared: false } : response);
    }

    const reloadId = nanoid();
    await c.env.DB.prepare(
      "INSERT INTO shares (id, post_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
      .bind(reloadId, postId, currentUser.id, actorUrl)
      .run();

    const result = await c.env.DB.prepare(
      'UPDATE posts SET reload_count = reload_count + 1, engagement_hotness = engagement_hotness + 3.0 WHERE id = ? RETURNING reload_count',
    )
      .bind(postId)
      .first<{ reload_count: number }>();

    // Remote posts are stored under the receiving local account; only notify
    // the author of a genuinely local post.
    if (!post.actor_id && post.user_id !== currentUser.id) {
      try {
        const existingNotif = (await c.env.DB.prepare(
          "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'reload' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(post.user_id, postId)
          .first()) as Record<string, unknown> | null;

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? (JSON.parse(existingNotif.actor_data as string) as string[])
            : existingNotif.actor_id
              ? [existingNotif.actor_id as string]
              : [];
          if (!actorData.includes(currentUser.id)) actorData.push(currentUser.id);
          await c.env.DB.prepare(
            "UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), read = 0 WHERE id = ?",
          )
            .bind(actorData[0], JSON.stringify(actorData), existingNotif.id as string)
            .run();
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(nanoid(), post.user_id, 'reload', postId, currentUser.id)
            .run();
          waitUntil(
            c,
            () =>
              sendPushToAll(
                c.env,
                post.user_id,
                'reload',
                currentUser.username,
                currentUser.display_name,
                post.text,
                postId,
              ),
            'Failed to send reload push',
          );
        }
      } catch (e) {
        console.error('Failed to create reload notification:', e);
      }
    }

    const announce = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${c.env.BASE_URL}/activities/announce-${reloadId}`,
      type: 'Announce',
      actor: actorUrl,
      object: noteUrl,
      to: [publicAudience],
      cc: [`${c.env.BASE_URL}/api/actors/${currentUser.username}/followers`],
      published: new Date().toISOString(),
    };
    deliverReloadActivity(c, post, currentUser, announce);

    const response = { reloaded: true, is_reloaded: true, reload_count: result?.reload_count ?? 0 };
    return c.json(legacyAlias ? { ...response, shared: true, share_id: reloadId } : response);
  } catch (error: unknown) {
    console.error('Reload error:', error);
    return c.json({ error: 'Reload operation failed' }, 500);
  }
};

engagement.post('/posts/:id/reload', requireAuth, (c) => toggleReload(c));
// Deprecated alias kept for API clients that used the old share endpoint.
engagement.post('/posts/:id/share', requireAuth, (c) => toggleReload(c, true));

// GET /api/posts/:id/replies - get direct replies
