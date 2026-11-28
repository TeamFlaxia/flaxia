import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { PostVisibility } from '../../../../shared/types/post.ts';
import { enrichPostsWithRemoteAuthors } from '../../../lib/activitypub/authors';
import { extractMentionHandles } from '../../../lib/activitypub/text.ts';
import { embedPost, screenPostImages } from '../../../lib/crowd';
import { sendPushToAll, waitUntil } from '../../../lib/notify';
import { clampLimit } from '../../../lib/pagination';
import type { Db } from '../../../lib/ports/index.ts';
import { EXACT_DUPLICATE_FILTER } from '../../../lib/post-visibility';
import { quoteNotificationDecision } from '../../../lib/quote-notification';
import { runInBackground } from '../../../lib/scan/index';
import { enrichPostsForFeed } from '../../feed-enrichment';
import { requireAuth, resolveMentions, resolveRequestUser } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';
import { colorEntitlementError, isValidPostId, visibilityFilter } from './helpers.ts';

export const replies = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const VISIBILITIES = new Set<string>(['public', 'unlisted', 'private', 'direct']);

type ParentRow = {
  id: string;
  user_id: string;
  username: string;
  text: string;
  depth: number;
  root_id: string | null;
  visibility?: unknown;
  mentions?: unknown;
  visibility_root_author_id?: string | null;
};

type MentionEntry = { username?: unknown; user_id?: unknown };

function parseMentionEntries(json: unknown): MentionEntry[] {
  if (typeof json !== 'string') return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as MentionEntry[]) : [];
  } catch {
    return [];
  }
}

/** Replies inherit the parent audience; a legacy/unknown value fails closed to public. */
function inheritedVisibility(parent: { visibility?: unknown }): PostVisibility {
  const value = parent.visibility;
  return typeof value === 'string' && VISIBILITIES.has(value) ? (value as PostVisibility) : 'public';
}

/**
 * A followers-only reply belongs to the root thread author's followers, not
 * to the followers of the user who wrote the parent reply. The parent may be a
 * private reply itself, so carry its pinned root author forward and only fall
 * back to the parent author for legacy rows with no pinned value. Other
 * visibilities keep their inherited value and leave the column NULL.
 */
function inheritedVisibilityRootAuthorId(parent: ParentRow): string | null {
  if (inheritedVisibility(parent) !== 'private') return null;
  return parent.visibility_root_author_id ?? parent.user_id;
}

/**
 * Decide whether a reply notification may reach a recipient. The read check
 * uses the very same predicate as GET /api/posts/:id, and restricted replies
 * are metadata-only so a push can never carry the private body.
 */
async function replyNotificationDecision(
  db: Db,
  replyId: string,
  targetUserId: string,
  visibility: PostVisibility,
  text: string,
): Promise<{ notify: boolean; pushPreview: string }> {
  const { sql, params } = visibilityFilter(targetUserId);
  const readable = await db
    .prepare(`SELECT p.id FROM posts p WHERE p.id = ? ${sql}`)
    .bind(replyId, ...params)
    .first<{ id: string }>();
  return quoteNotificationDecision(visibility, Boolean(readable), text);
}

/**
 * Keep the parent's local recipients on a direct reply. Without this the reply
 * would inherit `direct` but none of the parent's recipients would be listed in
 * `mentions`, so the very people allowed to read the parent could not read the
 * reply. Text mentions are preserved and de-duplicated by user id.
 */
function replyMentionsJson(parent: ParentRow, resolvedTextMentions: string): string {
  const merged = parseMentionEntries(resolvedTextMentions);
  if (inheritedVisibility(parent) !== 'direct') return resolvedTextMentions;

  const seen = new Set<string>();
  for (const entry of merged) {
    if (typeof entry?.user_id === 'string') seen.add(entry.user_id);
  }
  for (const entry of parseMentionEntries(parent.mentions)) {
    const userId = entry?.user_id;
    if (typeof userId !== 'string' || seen.has(userId)) continue;
    seen.add(userId);
    merged.push({ username: entry.username, user_id: userId });
  }
  return JSON.stringify(merged);
}

replies.get('/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const limit = clampLimit(c.req.query('limit'), 20, 50);

    // Reuse the user authMiddleware already resolved; session is optional here.
    const user = await resolveRequestUser(c, c.get('user'));
    const currentUserId = user?.id ?? null;
    const visibility = visibilityFilter(currentUserId);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Verify parent post exists, is published, and is visible to this viewer
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reload_count, 0) as reload_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at, visibility FROM posts p WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0 " +
        visibility.sql,
    )
      .bind(postId, ...visibility.params)
      .first();

    if (!parentPost) {
      return c.json({ error: 'Post not found' }, 404);
    }

    let query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.visibility,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.hidden = 0 ${EXACT_DUPLICATE_FILTER} ${visibility.sql}
       ORDER BY p.created_at ASC LIMIT ?`;
    const params: Array<unknown> = [postId, ...visibility.params, limit];

    if (cursor) {
      query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.visibility,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.hidden = 0 ${EXACT_DUPLICATE_FILTER} ${visibility.sql} AND p.created_at < ?
       ORDER BY p.created_at ASC LIMIT ?`;
      params.splice(1 + visibility.params.length, 0, cursor);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch replies' }, 500);
    }

    const replies = result.results || [];
    const _nextCursor = replies.length === limit ? replies[replies.length - 1].created_at : null;

    // Enrich parent and replies in a single batch. The old code ran the same
    // four enrichment queries twice (once on replies, then again on both the
    // parent and replies) before responding.
    const allPosts: Array<Record<string, unknown>> = [
      parentPost as Record<string, unknown>,
      ...(replies as Array<Record<string, unknown>>),
    ];
    // Authors run after feed enrichment so quoted_post is already populated.
    await enrichPostsForFeed(allPosts as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithRemoteAuthors(allPosts, c.env.DB);

    // Trigger vector embedding for unprocessed posts in background
    const toEmbed = allPosts.filter((p) => p.text);
    if (toEmbed.length > 0) {
      const existingRows = await c.env.DB.prepare(
        `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed.map(() => '?').join(',')})`,
      )
        .bind(...toEmbed.map((p) => p.id as string))
        .all<{ post_id: string }>();
      const existingIds = new Set((existingRows.results || []).map((r) => r.post_id));
      for (const p of toEmbed) {
        if (!existingIds.has(p.id as string)) {
          runInBackground(
            c,
            () => embedPost(c.env.DB, c.env, p.id as string, p.text as string),
            'Background embed failed',
          );
        }
      }
    }

    return c.json({ root: parentPost, replies });
  } catch (error: unknown) {
    console.error('Thread fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/posts/:id/thread - get full thread
replies.get('/posts/:id/thread', async (c) => {
  try {
    const postId = c.req.param('id');

    const user = await resolveRequestUser(c, c.get('user'));
    const currentUserId = user?.id ?? null;
    const visibility = visibilityFilter(currentUserId);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, thumbnail_key, game_description, game_title, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at, visibility FROM posts p WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0 " +
        visibility.sql,
    )
      .bind(postId, ...visibility.params)
      .first();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const rootId = (post as Record<string, unknown>).root_id || (post as Record<string, unknown>).id;

    const rootPost = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.game_description, p.game_title, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.visibility,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0 ${visibility.sql}`,
    )
      .bind(rootId, ...visibility.params)
      .first();

    if (!rootPost) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const repliesResult = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.game_description, p.game_title, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.visibility,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.root_id = ? AND p.status = 'published' AND p.hidden = 0 AND p.id != ? ${EXACT_DUPLICATE_FILTER} ${visibility.sql}
       ORDER BY p.created_at ASC LIMIT 200`,
    )
      .bind(rootId, rootId, ...visibility.params)
      .all();

    if (!repliesResult.success) {
      return c.json({ error: 'Failed to fetch thread' }, 500);
    }

    const replies = repliesResult.results || [];

    // Root and replies were fetched in one pass. Enrich the merged array once:
    // the shared feed helper runs polls + quotes + attachments + reactions +
    // viewer flags in a single Promise.all instead of eight serial awaits, and
    // the remote-author lookup must run AFTER it so quoted posts are enriched.
    const allPosts: Array<Record<string, unknown>> = [
      rootPost as Record<string, unknown>,
      ...(replies as Array<Record<string, unknown>>),
    ];
    await enrichPostsForFeed(allPosts as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithRemoteAuthors(allPosts, c.env.DB);

    // Vector embedding is background work. Neither the existence query nor the
    // embedPost dispatch may hold up the thread response.
    waitUntil(
      c,
      async () => {
        const toEmbed = allPosts.filter((p) => p.text);
        if (toEmbed.length === 0) return;
        const existingRows = await c.env.DB.prepare(
          `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed.map(() => '?').join(',')})`,
        )
          .bind(...toEmbed.map((p) => p.id as string))
          .all<{ post_id: string }>();
        const existingIds = new Set((existingRows.results || []).map((r) => r.post_id));
        for (const p of toEmbed) {
          if (!existingIds.has(p.id as string)) {
            runInBackground(
              c,
              () => embedPost(c.env.DB, c.env, p.id as string, p.text as string),
              'Background embed failed',
            );
          }
        }
      },
      'thread-embed',
    );

    return c.json({ root: rootPost, replies });
  } catch (error: unknown) {
    console.error('Thread fetch error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Step 1 — POST /api/posts/:id/replies/prepare (protected)
replies.post('/posts/:id/replies/prepare', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id');
    const { filename, contentType } = await c.req.json();

    if (!filename || !contentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400);
    }

    const allowedTypes = [
      'image/gif',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/mp4',
      'audio/webm',
    ];
    if (!allowedTypes.includes(contentType)) {
      return c.json(
        { error: 'Only image files (GIF, PNG, JPG) and audio files (MP3, WAV, OGG, M4A, WebM) are supported' },
        400,
      );
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent post exists, is published, and is visible to the author
    const visibility = visibilityFilter(c.get('user')?.id);
    const parentPost = (await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at, visibility, visibility_root_author_id FROM posts p WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0 " +
        visibility.sql,
    )
      .bind(postId, ...visibility.params)
      .first()) as ParentRow | null;

    if (!parentPost) {
      return c.json({ error: 'Parent post not found' }, 404);
    }

    const replyId = crypto.randomUUID();
    let fileExtension: string;
    let storageKey: string;

    if (contentType.startsWith('image/')) {
      fileExtension =
        contentType === 'image/png'
          ? '.png'
          : contentType === 'image/jpeg' || contentType === 'image/jpg'
            ? '.jpg'
            : '.gif';
      storageKey = `gif/${replyId}${fileExtension}`;
    } else if (contentType.startsWith('audio/')) {
      fileExtension =
        contentType === 'audio/mpeg'
          ? '.mp3'
          : contentType === 'audio/wav'
            ? '.wav'
            : contentType === 'audio/ogg'
              ? '.ogg'
              : contentType === 'audio/mp4'
                ? '.m4a'
                : '.webm';
      storageKey = `audio/${replyId}${fileExtension}`;
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const gifKey = storageKey;

    // Compute depth and root_id
    const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
    const rootId = parentPost.root_id || parentPost.id;

    // Store pending reply in D1
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count, visibility, visibility_root_author_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'pending', ?, ?, ?, 0, ?, ?)
    `)
      .bind(
        replyId,
        c.get('user')?.id || '',
        c.get('user')?.username || 'anonymous',
        '',
        '[]',
        replyMentionsJson(parentPost, '[]'),
        gifKey,
        '',
        '',
        postId,
        rootId,
        depth,
        inheritedVisibility(parentPost),
        inheritedVisibilityRootAuthorId(parentPost),
      )
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create pending reply' }, 500);
    }

    // Generate upload endpoint URL (our own API)
    const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`;

    return c.json({
      replyId,
      gifUploadUrl,
      gifKey,
    });
  } catch (error: unknown) {
    console.error('Prepare reply error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Step 3 — POST /api/posts/:id/replies/commit (protected)
replies.post('/posts/:id/replies/commit', requireAuth, async (c) => {
  const postId = c.req.param('id');

  try {
    const { replyId, gifKey, text, hashtags } = await c.req.json();

    if (!isValidPostId(replyId)) {
      return c.json({ error: 'Invalid reply ID format' }, 422);
    }

    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422);
    }
    const colorError = colorEntitlementError(c, text);
    if (colorError) return colorError;

    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
    }

    for (const tag of hashtags) {
      if (
        typeof tag !== 'string' ||
        tag.length > 20 ||
        !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)
      ) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422);
      }
    }

    // Extract mentions from text (local and cross-instance handles).
    const mentionedHandles = extractMentionHandles(text);
    const mentionedUsernames = mentionedHandles.map((handle) => handle.username);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent still exists, is published, and is visible to the author
    const visibility = visibilityFilter(c.get('user')?.id);
    const parentPost = (await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at, visibility, visibility_root_author_id FROM posts p WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0 " +
        visibility.sql,
    )
      .bind(postId, ...visibility.params)
      .first()) as ParentRow | null;

    if (!parentPost) {
      return c.json({ error: 'Parent post no longer available' }, 422);
    }

    const replyVisibility = inheritedVisibility(parentPost);
    let reply: Record<string, unknown> | undefined;
    let mentionsJson: string | null = '[]';

    if (gifKey) {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = replyMentionsJson(
        parentPost,
        await resolveMentions(c.env.DB, mentionedHandles, replyUsername, c.env),
      );

      // Validate that this is a pending reply of the CALLER and gifKey matches
      const pendingReply = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND gif_key = ? AND parent_id = ? AND user_id = ?
      `)
        .bind(replyId, gifKey, postId, c.get('user')?.id || '')
        .first();

      if (!pendingReply) {
        return c.json({ error: 'Invalid or expired reply preparation' }, 422);
      }

      // The key must be an object this reply's prepare step minted
      // (`gif/<replyId>.<ext>` or `audio/<replyId>.<ext>`) and actually
      // present in R2: otherwise any reachable object could be attached.
      if (!gifKey.startsWith(`gif/${replyId}.`) && !gifKey.startsWith(`audio/${replyId}.`)) {
        return c.json({ error: 'Invalid reply media key' }, 422);
      }
      if (c.env.BUCKET && !(await c.env.BUCKET.head(gifKey))) {
        return c.json({ error: 'GIF not uploaded' }, 422);
      }

      // Update reply to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, mentions = ?, visibility = ?, visibility_root_author_id = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND user_id = ? AND status = 'pending'
      `)
        .bind(
          text,
          JSON.stringify(hashtags),
          mentionsJson,
          replyVisibility,
          inheritedVisibilityRootAuthorId(parentPost),
          replyId,
          c.get('user')?.id || '',
        )
        .run();

      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit reply' }, 500);
      }

      if (updateResult.meta.changes === 0) return c.json({ error: 'Reply preparation has expired' }, 409);

      // Return the updated reply
      reply =
        (await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.visibility FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ?
      `)
          .bind(replyId)
          .first()) ?? undefined;
    } else {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = replyMentionsJson(
        parentPost,
        await resolveMentions(c.env.DB, mentionedHandles, replyUsername, c.env),
      );

      // Create text-only reply directly
      const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
      const rootId = parentPost.root_id || parentPost.id;

      try {
        const result = await c.env.DB.prepare(`
          INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count, visibility, visibility_root_author_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'published', ?, ?, ?, 0, ?, ?)
        `)
          .bind(
            replyId,
            c.get('user')?.id || '',
            replyUsername,
            text,
            JSON.stringify(hashtags),
            mentionsJson,
            '',
            '',
            '',
            postId,
            rootId,
            depth,
            replyVisibility,
            inheritedVisibilityRootAuthorId(parentPost),
          )
          .run();

        if (!result.success) {
          console.error('Failed to create reply:', result.error);
          return c.json({ error: 'Failed to create reply' }, 500);
        }

        // Return the created reply
        reply =
          (await c.env.DB.prepare(`
          SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at, p.visibility FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ?
        `)
            .bind(replyId)
            .first()) ?? undefined;
      } catch (dbError: unknown) {
        const err = dbError as { message?: string; stack?: string; cause?: unknown; name?: string };
        console.error('Database error creating reply:', dbError);
        console.error('Error details:', {
          message: err.message,
          stack: err.stack,
          cause: err.cause,
          name: err.name,
        });
        return c.json({ error: 'Database error' }, 500);
      }
    }

    // Increment parent's reply count and engagement hotness
    const incrementResult = await c.env.DB.prepare(`
      UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1, engagement_hotness = COALESCE(engagement_hotness, 1.0) + 3.0 WHERE id = ?
    `)
      .bind(postId)
      .run();

    if (!incrementResult.success) {
      console.error('Failed to increment reply count for post:', postId);
      // Don't fail the whole operation, just log the error
    }

    // Create notification for the parent post author (if not replying to own post)
    const notifiedUserIds = new Set<string>();
    const replyUserId = c.get('user')?.id || '';
    if (parentPost.user_id !== replyUserId) {
      try {
        const decision = await replyNotificationDecision(c.env.DB, replyId, parentPost.user_id, replyVisibility, text);
        // Never notify (or push to) someone who cannot read the reply.
        if (decision.notify) {
          // Group reply notifications: check for existing reply notification for this post
          const existingNotif = (await c.env.DB.prepare(
            "SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = 'reply' ORDER BY created_at DESC LIMIT 1",
          )
            .bind(parentPost.user_id, postId)
            .first()) as Record<string, unknown>;

          if (existingNotif) {
            const actorData = existingNotif.actor_data
              ? JSON.parse(existingNotif.actor_data as string)
              : existingNotif.actor_id
                ? [existingNotif.actor_id as string]
                : [];
            if (!actorData.includes(replyUserId)) {
              actorData.push(replyUserId);
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
              .bind(nanoid(), parentPost.user_id, 'reply', postId, replyUserId)
              .run();
            // Restricted replies are metadata-only: no private body in the push.
            const actor = c.get('user');
            await sendPushToAll(
              c.env,
              parentPost.user_id,
              'reply',
              actor?.username,
              actor?.display_name,
              decision.pushPreview,
              postId,
            );
          }
          notifiedUserIds.add(parentPost.user_id);
        }
      } catch (e) {
        console.error('Failed to create reply notification:', e);
        // Don't fail the whole operation, just log the error
      }
    }

    // Create mention notifications for mentioned users in the reply
    // (skip self-mentions, users already notified for this reply, and duplicates)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{ username: string; user_id: string }>;
        const mentionTargets: Array<{ userId: string; pushPreview: string }> = [];
        for (const mention of mentionData) {
          if (mention.user_id === replyUserId) continue;
          if (notifiedUserIds.has(mention.user_id)) continue;
          // A mention is not an invitation: only recipients who can actually
          // read the reply get a notification, and restricted bodies stay out
          // of the push preview.
          const decision = await replyNotificationDecision(c.env.DB, replyId, mention.user_id, replyVisibility, text);
          if (!decision.notify) continue;
          notifiedUserIds.add(mention.user_id);
          mentionTargets.push({ userId: mention.user_id, pushPreview: decision.pushPreview });
        }
        const mentionStmts = mentionTargets.map((m) =>
          c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          ).bind(nanoid(), m.userId, 'mention', replyId, replyUserId),
        );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        const actor = c.get('user');
        for (const mention of mentionTargets) {
          await sendPushToAll(
            c.env,
            mention.userId,
            'mention',
            actor?.username,
            actor?.display_name,
            mention.pushPreview,
            postId,
          );
        }
      } catch (e) {
        // Don't fail the reply creation if mention notifications fail
        console.error('Failed to create mention notifications:', e);
      }
    }

    // Create notifications for >>N post references in the reply
    // Skip if the referenced post author was already notified (e.g., parent post author)
    try {
      const refRegex = />>(\d+)/g;
      const referencedIndices = new Set<number>();
      let refMatch: RegExpExecArray | null;
      while ((refMatch = refRegex.exec(text)) !== null) {
        const index = parseInt(refMatch[1], 10);
        if (index > 0) referencedIndices.add(index);
      }

      if (referencedIndices.size > 0) {
        const rootId = parentPost.root_id || parentPost.id;
        const allRepliesResult = await c.env.DB.prepare(
          "SELECT id, user_id, username FROM posts WHERE root_id = ? AND status = 'published' AND hidden = 0 AND id != ? ORDER BY created_at ASC",
        )
          .bind(rootId, rootId)
          .all();

        const allReplies = allRepliesResult.results || [];

        const refUpdateStmts: D1PreparedStatement[] = [];
        const refNotifyStmts: D1PreparedStatement[] = [];
        const refNotifyTargets: Array<{ userId: string; pushPreview: string }> = [];
        for (const refIndex of referencedIndices) {
          const arrayIndex = refIndex - 1;
          if (arrayIndex >= 0 && arrayIndex < allReplies.length) {
            const referencedPost = allReplies[arrayIndex] as Record<string, unknown>;
            if (referencedPost.id !== postId) {
              refUpdateStmts.push(
                c.env.DB.prepare(
                  'UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1, engagement_hotness = COALESCE(engagement_hotness, 1.0) + 3.0 WHERE id = ?',
                ).bind(referencedPost.id as string),
              );
            }
            const targetUserId = referencedPost.user_id as string | undefined;
            if (targetUserId && targetUserId !== replyUserId && !notifiedUserIds.has(targetUserId)) {
              const decision = await replyNotificationDecision(
                c.env.DB,
                replyId,
                targetUserId,
                replyVisibility,
                text || '',
              );
              if (!decision.notify) continue;
              notifiedUserIds.add(targetUserId);
              refNotifyStmts.push(
                c.env.DB.prepare(
                  'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                ).bind(nanoid(), targetUserId, 'reply', replyId, replyUserId),
              );
              refNotifyTargets.push({ userId: targetUserId, pushPreview: decision.pushPreview });
            }
          }
        }
        const allRefStmts = [...refUpdateStmts, ...refNotifyStmts];
        if (allRefStmts.length > 0) {
          await c.env.DB.batch(allRefStmts);
        }
        for (const target of refNotifyTargets) {
          const actor = c.get('user');
          await sendPushToAll(
            c.env,
            target.userId,
            'reply',
            actor?.username,
            actor?.display_name,
            target.pushPreview,
            replyId,
          );
        }
      }
    } catch (e) {
      console.error('Failed to create >>N reference notifications:', e);
    }

    if (gifKey) {
      screenPostImages(c.env.DB, c.env, replyId, [gifKey]).catch((e) =>
        console.error('Background NSFW screen failed:', e),
      );
    }

    return c.json({ reply });
  } catch (error: unknown) {
    const err = error as { message?: string; stack?: string; cause?: unknown; name?: string; replyId?: string };
    console.error('Commit reply error:', error);
    console.error('Full error details:', {
      message: err.message,
      stack: err.stack,
      cause: err.cause,
      name: err.name,
      postId: postId || 'unknown',
      replyId: err.replyId || 'unknown',
    });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/search - search posts and users
