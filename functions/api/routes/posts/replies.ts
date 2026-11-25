import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { enrichPostsWithRemoteAuthors } from '../../../lib/activitypub/authors';
import { enrichPostsWithAttachments } from '../../../lib/attachments';
import { embedPost, screenPostImages } from '../../../lib/crowd';
import { sendPushToAll } from '../../../lib/notify';
import { clampLimit } from '../../../lib/pagination';
import { EXACT_DUPLICATE_FILTER } from '../../../lib/post-visibility';
import { runInBackground } from '../../../lib/scan/index';
import { enrichPostsWithPolls, enrichPostsWithQuotes, enrichPostsWithReactions } from '../../feed-enrichment';
import { batchGetFreshAndBookmarkStatus, requireAuth, resolveMentions, resolveRequestUser } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';
import { colorEntitlementError, isValidPostId } from './helpers.ts';

export const replies = new Hono<{ Bindings: Bindings; Variables: Variables }>();

replies.get('/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const limit = clampLimit(c.req.query('limit'), 20, 50);

    // Reuse the user authMiddleware already resolved; session is optional here.
    const user = await resolveRequestUser(c, c.get('user'));
    const currentUserId = user?.id ?? null;

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Verify parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reload_count, 0) as reload_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published' AND hidden = 0",
    )
      .bind(postId)
      .first();

    if (!parentPost) {
      return c.json({ error: 'Post not found' }, 404);
    }

    let query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.hidden = 0 ${EXACT_DUPLICATE_FILTER}
       ORDER BY p.created_at ASC LIMIT ?`;
    const params: Array<unknown> = [postId, limit];

    if (cursor) {
      query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.hidden = 0 ${EXACT_DUPLICATE_FILTER} AND p.created_at < ?
       ORDER BY p.created_at ASC LIMIT ?`;
      params.splice(1, 0, cursor);
    }

    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      return c.json({ error: 'Failed to fetch replies' }, 500);
    }

    const replies = result.results || [];
    const _nextCursor = replies.length === limit ? replies[replies.length - 1].created_at : null;

    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    if (currentUserId) {
      const allPostRows = [parentPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
      const { reloaded } = await batchGetFreshAndBookmarkStatus(
        c.env.DB,
        currentUserId,
        allPostRows.map((post) => String(post.id)),
      );
      allPostRows.forEach((post) => {
        post.is_reloaded = reloaded.has(String(post.id));
      });
    }

    // Add poll data
    await enrichPostsWithPolls([parentPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithQuotes([parentPost as PostRow], c.env.DB);
    await enrichPostsWithAttachments([parentPost as PostRow], c.env.DB);
    await enrichPostsWithReactions([parentPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    // Trigger vector embedding for unprocessed posts in background
    const allPosts = [parentPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
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

    await enrichPostsWithRemoteAuthors(
      [parentPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)],
      c.env.DB,
    );
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

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const post = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, thumbnail_key, game_description, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published' AND hidden = 0",
    )
      .bind(postId)
      .first();

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const rootId = (post as Record<string, unknown>).root_id || (post as Record<string, unknown>).id;

    const rootPost = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.game_description, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.id = ? AND p.status = 'published' AND p.hidden = 0`,
    )
      .bind(rootId)
      .first();

    if (!rootPost) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    const repliesResult = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.game_description, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.root_id = ? AND p.status = 'published' AND p.hidden = 0 AND p.id != ? ${EXACT_DUPLICATE_FILTER}
       ORDER BY p.created_at ASC LIMIT 200`,
    )
      .bind(rootId, rootId)
      .all();

    if (!repliesResult.success) {
      return c.json({ error: 'Failed to fetch thread' }, 500);
    }

    const replies = repliesResult.results || [];

    if (currentUserId) {
      const allPosts: Array<Record<string, unknown>> = [
        rootPost as Record<string, unknown>,
        ...(replies as Array<Record<string, unknown>>),
      ];
      const postIds = allPosts.map((p: Record<string, unknown>) => p.id as string);

      const { freshed, reloaded, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      (rootPost as Record<string, unknown>).is_freshed = freshed.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_freshed = freshed.has(post.id as string);
      });
      (rootPost as Record<string, unknown>).is_reloaded = reloaded.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_reloaded = reloaded.has(post.id as string);
      });
      (rootPost as Record<string, unknown>).is_bookmarked = bookmarked.has(
        (rootPost as Record<string, unknown>).id as string,
      );
      (replies as Array<Record<string, unknown>>).forEach((post: Record<string, unknown>) => {
        post.is_bookmarked = bookmarked.has(post.id as string);
      });
    }

    await enrichPostsWithPolls([rootPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithQuotes([rootPost as PostRow], c.env.DB);
    await enrichPostsWithAttachments([rootPost as PostRow], c.env.DB);
    await enrichPostsWithReactions([rootPost as PostRow], c.env.DB, currentUserId);
    await enrichPostsWithPolls(replies as PostRow[], c.env.DB, currentUserId);
    await enrichPostsWithQuotes(replies as PostRow[], c.env.DB);
    await enrichPostsWithAttachments(replies as PostRow[], c.env.DB);
    await enrichPostsWithReactions(replies as PostRow[], c.env.DB, currentUserId);

    const allPosts2 = [rootPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)];
    const toEmbed2 = allPosts2.filter((p) => p.text);
    if (toEmbed2.length > 0) {
      const existingRows2 = await c.env.DB.prepare(
        `SELECT post_id FROM post_embeddings WHERE post_id IN (${toEmbed2.map(() => '?').join(',')})`,
      )
        .bind(...toEmbed2.map((p) => p.id as string))
        .all<{ post_id: string }>();
      const existingIds2 = new Set((existingRows2.results || []).map((r) => r.post_id));
      for (const p of toEmbed2) {
        if (!existingIds2.has(p.id as string)) {
          runInBackground(
            c,
            () => embedPost(c.env.DB, c.env, p.id as string, p.text as string),
            'Background embed failed',
          );
        }
      }
    }

    await enrichPostsWithRemoteAuthors(
      [rootPost as Record<string, unknown>, ...(replies as Array<Record<string, unknown>>)],
      c.env.DB,
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

    // Validate parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published' AND hidden = 0",
    )
      .bind(postId)
      .first();

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
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'pending', ?, ?, ?, 0)
    `)
      .bind(
        replyId,
        c.get('user')?.id || '',
        c.get('user')?.username || 'anonymous',
        '',
        '[]',
        '[]',
        gifKey,
        '',
        '',
        postId,
        rootId,
        depth,
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

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    const mentionSet = new Set<string>();
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1]);
    }
    const mentionedUsernames = Array.from(mentionSet);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate parent still exists and is published
    const parentPost = (await c.env.DB.prepare(
      "SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, 'published') as status, created_at FROM posts WHERE id = ? AND status = 'published' AND hidden = 0",
    )
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      username: string;
      text: string;
      depth: number;
      root_id: string | null;
    } | null;

    if (!parentPost) {
      return c.json({ error: 'Parent post no longer available' }, 422);
    }

    let reply: Record<string, unknown> | undefined;
    let mentionsJson: string | null = '[]';

    if (gifKey) {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername);

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
        SET text = ?, hashtags = ?, mentions = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND user_id = ? AND status = 'pending'
      `)
        .bind(text, JSON.stringify(hashtags), mentionsJson, replyId, c.get('user')?.id || '')
        .run();

      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit reply' }, 500);
      }

      if (updateResult.meta.changes === 0) return c.json({ error: 'Reply preparation has expired' }, 409);

      // Return the updated reply
      reply =
        (await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ?
      `)
          .bind(replyId)
          .first()) ?? undefined;
    } else {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous';
      mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername);

      // Create text-only reply directly
      const depth = Math.min(Number(parentPost.depth || 0) + 1, 5);
      const rootId = parentPost.root_id || parentPost.id;

      try {
        const result = await c.env.DB.prepare(`
          INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, engagement_hotness, status, parent_id, root_id, depth, reply_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'published', ?, ?, ?, 0)
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
          )
          .run();

        if (!result.success) {
          console.error('Failed to create reply:', result.error);
          return c.json({ error: 'Failed to create reply' }, 500);
        }

        // Return the created reply
        reply =
          (await c.env.DB.prepare(`
          SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.hidden, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id
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
          // Send push notification to parent post author
          {
            const actor = c.get('user');

            await sendPushToAll(c.env, parentPost.user_id, 'reply', actor?.username, actor?.display_name, text, postId);
          }
        }
        notifiedUserIds.add(parentPost.user_id);
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
        const mentionTargets = mentionData.filter((m) => {
          if (m.user_id === replyUserId) return false;
          if (notifiedUserIds.has(m.user_id)) return false;
          notifiedUserIds.add(m.user_id);
          return true;
        });
        const mentionStmts = mentionTargets.map((m) =>
          c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          ).bind(nanoid(), m.user_id, 'mention', replyId, replyUserId),
        );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        const actor = c.get('user');
        for (const mention of mentionTargets) {
          await sendPushToAll(c.env, mention.user_id, 'mention', actor?.username, actor?.display_name, text, postId);
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
        const refNotifyTargets: Array<{ userId: string; user_id: string }> = [];
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
            if (
              referencedPost.user_id &&
              (referencedPost.user_id as string) !== replyUserId &&
              !notifiedUserIds.has(referencedPost.user_id as string)
            ) {
              refNotifyStmts.push(
                c.env.DB.prepare(
                  'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
                ).bind(nanoid(), referencedPost.user_id as string, 'reply', replyId, replyUserId),
              );
              refNotifyTargets.push({
                userId: referencedPost.user_id as string,
                user_id: referencedPost.user_id as string,
              });
            }
          }
        }
        const allRefStmts = [...refUpdateStmts, ...refNotifyStmts];
        if (allRefStmts.length > 0) {
          await c.env.DB.batch(allRefStmts);
        }
        for (const target of refNotifyTargets) {
          const actor = c.get('user');
          await sendPushToAll(c.env, target.userId, 'reply', actor?.username, actor?.display_name, text || '', replyId);
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
