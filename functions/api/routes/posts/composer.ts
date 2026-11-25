import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { deliverToFollowers } from '../../../lib/activitypub/delivery';
import { buildCreateActivity, buildNoteObject, loadNoteAttachments } from '../../../lib/activitypub/note';
import {
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentRecord,
  attachmentBudget,
  buildAttachmentKey,
  enrichPostsWithAttachments,
  imageAttachmentKeys,
  kindFromUpload,
  parseAttachmentKey,
  sequenceAttachments,
  validateAttachmentInputs,
} from '../../../lib/attachments';
import { embedPost, isImageKey, type PostMediaInput, screenPostImages, tagPost } from '../../../lib/crowd';
import { validateImageDimensions } from '../../../lib/image-dimensions';
import { sendPushToAll, waitUntil } from '../../../lib/notify';
import { checkRateLimit } from '../../../lib/rate-limit';
import { submitFileScans } from '../../../lib/scan/clamav';
import { runInBackground, scanUploadSync } from '../../../lib/scan/index';
import { refreshUserTrustSafe } from '../../../lib/trust';
import { copyHtmlToWvfs, extractZipToR2 } from '../../../lib/wvfs-zip-server.ts';
import { enrichPostsWithPolls, enrichPostsWithQuotes, enrichPostsWithReactions } from '../../feed-enrichment';
import { requireAuth, resolveMentions } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';
import { extractGameDescription } from '../post-versions';
import { colorEntitlementError, isOwnedMediaKey, isValidPostId, resolveAttachmentLimit } from './helpers.ts';

export const composer = new Hono<{ Bindings: Bindings; Variables: Variables }>();

composer.post('/posts/:id/prepare-attachment', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    const { filename } = await c.req.json();

    if (!filename) return c.json({ error: 'Missing filename' }, 400);

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const post = await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ id: string; user_id: string; status: string } | null>();

    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Cannot edit this post' }, 400);

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];

    let storageKey: string;
    let keyType: string;

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`;
      keyType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `zip/${postId}.zip`;
      keyType = 'payload';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `html/${postId}.html`;
      keyType = 'payload';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `audio/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `video/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `gif/${postId}${extMap[ext]}`;
      keyType = 'gif';
    } else {
      const safeExt = ext ? `.${ext}` : '';
      storageKey = `payload/${postId}${safeExt}`;
      keyType = 'payload';
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;

    return c.json({ uploadUrl, key: storageKey, keyType });
  } catch (error: unknown) {
    console.error('Prepare attachment error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/posts/:id/prepare-media — reserve an upload slot for one more
// image/audio/video attachment on an existing published post (protected).
composer.post('/posts/:id/prepare-media', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    // Every call mints upload URLs: throttle per user so abandoned
    // preparations cannot bloat R2/D1 without bound.
    if (
      !(await checkRateLimit(c.env.CACHE, `post:prepare:${user.id}`, {
        maxRequests: 30,
        windowSeconds: 60,
      }))
    ) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const postId = c.req.param('id');
    const { filename, contentType, reservedKeys } = (await c.req.json()) as {
      filename?: string;
      contentType?: string;
      reservedKeys?: unknown;
    };

    if (!postId) return c.json({ error: 'Missing post id' }, 400);
    if (!filename) return c.json({ error: 'Missing filename' }, 400);
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const kind = kindFromUpload(filename, contentType);
    if (!kind) return c.json({ error: 'Only image, audio, video, and PDF files are allowed' }, 400);

    const post = await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ id: string; user_id: string; status: string } | null>();
    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Cannot edit this post' }, 400);

    // Slots already spoken for. `reservedKeys` is the client's full planned
    // list for this edit session (attachments it keeps plus slots it has
    // already prepared but not yet committed) — without it every call in one
    // session would be handed the same slot. Falls back to the stored rows
    // for callers that do not send the list.
    const plannedKeys: string[] = [];
    if (Array.isArray(reservedKeys)) {
      for (const k of reservedKeys) {
        if (typeof k === 'string' && parseAttachmentKey(k)?.postId === postId) plannedKeys.push(k);
      }
    } else {
      const existing = await c.env.DB.prepare('SELECT r2_key FROM post_attachments WHERE post_id = ?')
        .bind(postId)
        .all<{ r2_key: string }>();
      plannedKeys.push(...(existing.results || []).map((r) => r.r2_key));
    }

    const maxAttachments = await resolveAttachmentLimit(c.env, user.id);

    if (plannedKeys.length + 1 > maxAttachments) {
      return c.json({ error: `Maximum ${maxAttachments} attachments allowed` }, 400);
    }

    // Occupancy comes from the slot embedded in the R2 key, not the
    // position column: sequenceAttachments renumbers positions on save while
    // keys keep their original slot, so the two drift after any removal.
    const usedSlots = new Set<number>();
    for (const planned of plannedKeys) {
      const parsed = parseAttachmentKey(planned);
      if (parsed) usedSlots.add(parsed.position);
    }

    let key: string | null = null;
    for (let p = 1; p <= maxAttachments && !key; p++) {
      if (usedSlots.has(p)) continue;
      const candidate = buildAttachmentKey(postId, p, filename, contentType);
      if (!candidate) return c.json({ error: 'Invalid filename' }, 400);
      // Skip a slot whose object still exists in R2 but is not planned for
      // the save (dropped attachment not committed yet, or a stale orphan) so
      // the upload cannot clobber a post that is still referencing it.
      if (c.env.BUCKET && (await c.env.BUCKET.head(candidate))) continue;
      key = candidate;
    }
    if (!key) return c.json({ error: `Maximum ${maxAttachments} attachments allowed` }, 400);

    const position = parseAttachmentKey(key)?.position ?? 0;
    return c.json({ uploadUrl: `${new URL(c.req.url).origin}/api/upload/${key}`, key, kind, position });
  } catch (error: unknown) {
    console.error('Prepare media error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Step 1 — POST /api/posts/prepare (protected)
composer.post('/posts/prepare', requireAuth, async (c) => {
  try {
    const body = (await c.req.json()) as {
      filename?: string;
      files?: Array<{ filename?: string; contentType?: string }>;
    };
    const { filename, files } = body;

    // Multi-media attachments (image/audio/video only, plan-dependent max, no html/swf/zip)
    if (Array.isArray(files)) {
      if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);
      const maxAttachments = await resolveAttachmentLimit(c.env, c.get('user')?.id || '');
      if (files.length === 0 || files.length > maxAttachments) {
        return c.json({ error: `Attachments must be 1-${maxAttachments} files` }, 400);
      }

      const postId = crypto.randomUUID();
      const uploads: Array<{ key: string; uploadUrl: string; kind: AttachmentKind }> = [];
      for (const file of files) {
        const name = file?.filename;
        if (typeof name !== 'string' || !name) {
          return c.json({ error: 'Missing filename' }, 400);
        }
        const kind = kindFromUpload(name, file.contentType);
        if (!kind) {
          return c.json({ error: 'Only image, audio, video, and PDF files are allowed' }, 400);
        }
        const key = buildAttachmentKey(postId, uploads.length + 1, name, file.contentType);
        if (!key) return c.json({ error: 'Invalid filename' }, 400);
        uploads.push({
          key,
          uploadUrl: `${new URL(c.req.url).origin}/api/upload/${key}`,
          kind,
        });
      }

      const result = await c.env.DB.prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, engagement_hotness, status)
         VALUES (?, ?, ?, ?, ?, 1.0, 'pending')`,
      )
        .bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]')
        .run();

      if (!result.success) {
        return c.json({ error: 'Failed to create pending post' }, 500);
      }

      return c.json({ postId, uploads });
    }

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const postId = crypto.randomUUID();

    let storageKey: string;
    let keyColumn: string;
    let responseType: 'gif' | 'zip' | 'swf';

    // SWF files
    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`;
      keyColumn = 'swf_key';
      responseType = 'swf';
    }
    // ZIP files
    else if (name.endsWith('.zip')) {
      storageKey = `zip/${postId}.zip`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }
    // HTML files
    else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `html/${postId}.html`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }
    // Audio files by extension
    else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `audio/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Video files by extension
    else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `video/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Image files by extension
    else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `gif/${postId}${extMap[ext]}`;
      keyColumn = 'gif_key';
      responseType = 'gif';
    }
    // Fallback: store as generic payload with original extension
    else {
      const safeExt = ext ? `.${ext}` : '';
      storageKey = `payload/${postId}${safeExt}`;
      keyColumn = 'payload_key';
      responseType = 'zip';
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, ${keyColumn}, engagement_hotness, status)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, 'pending')
    `)
      .bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]', storageKey)
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to create pending post' }, 500);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;
    const resp: Record<string, unknown> = { postId };

    if (responseType === 'zip') {
      resp.zipUploadUrl = uploadUrl;
      resp.zipKey = storageKey;
    } else if (responseType === 'swf') {
      resp.swfUploadUrl = uploadUrl;
      resp.swfKey = storageKey;
    } else {
      resp.gifUploadUrl = uploadUrl;
      resp.gifKey = storageKey;
    }

    return c.json(resp);
  } catch (error: unknown) {
    console.error('Prepare post error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Client-chosen post/reply IDs must be a safe, bounded format: IDs end up in
// URLs, R2 keys and HTML, so accepting arbitrary strings invites injection and
// key confusion. UUIDs and nanoids both match this pattern.
composer.post('/posts/commit', requireAuth, async (c) => {
  try {
    const contentType = c.req.header('content-type');
    let postId: string | undefined;
    let gifKey: string | undefined;
    let swfKey: string | undefined;
    let text: string;
    let requestHashtags: string[] = [];
    let pollData:
      | { question?: string; options?: string[]; multipleChoice?: boolean; endsAt?: string | null }
      | undefined;
    let zipKey: string | undefined;
    let thumbnailKey: string | undefined;
    let quotedPostId: string | undefined;
    let attachmentInputs: AttachmentInput[] | undefined;

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      text = formData.get('text') as string;
      postId = (formData.get('postId') as string) || undefined;
      if (postId) {
        // Reject another user's post id before the thumbnail write below:
        // ownership was only checked after the R2 put.
        const existingOwner = (await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ?')
          .bind(postId)
          .first()) as { user_id: string } | null;
        if (existingOwner && existingOwner.user_id !== (c.get('user')?.id || '')) {
          return c.json({ error: 'Forbidden' }, 403);
        }
      }
      gifKey = (formData.get('gifKey') as string) || undefined;
      swfKey = (formData.get('swfKey') as string) || undefined;
      zipKey = (formData.get('payloadKey') as string) || undefined;
      quotedPostId = (formData.get('quotedPostId') as string) || undefined;
      const pollStr = formData.get('poll') as string;
      pollData = pollStr ? JSON.parse(pollStr) : undefined;
      const attachmentsStr = formData.get('attachments') as string | null;
      if (attachmentsStr) attachmentInputs = JSON.parse(attachmentsStr);

      const thumbnailFile = (formData.get('thumbnail') as File | null) || undefined;
      if (thumbnailFile && thumbnailFile.size > 0) {
        if (thumbnailFile.size > 1024 * 1024) {
          return c.json({ error: 'Thumbnail must be ≤1MB' }, 400);
        }
        const allowedExts = ['jpg', 'jpeg', 'png', 'gif'];
        const ext = thumbnailFile.name.toLowerCase().split('.').pop();
        if (!ext || !allowedExts.includes(ext)) {
          return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400);
        }
        const thumbnailR2Key = `payload/${postId || crypto.randomUUID()}.thumb.${ext}`;
        const thumbnailBuffer = await thumbnailFile.arrayBuffer();

        const verdict = await scanUploadSync(c.env.DB, {
          bytes: thumbnailBuffer,
          declaredType: thumbnailFile.type,
          name: thumbnailR2Key,
          r2Key: thumbnailR2Key,
        });
        if (!verdict.ok) {
          return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
        }
        const thumbMime = verdict.detectedMime;

        const thumbnailDimError = validateImageDimensions(thumbnailBuffer, thumbMime);
        if (thumbnailDimError) {
          return c.json({ error: `Thumbnail too large. ${thumbnailDimError}` }, 413);
        }
        await c.env.BUCKET.put(thumbnailR2Key, thumbnailBuffer, {
          httpMetadata: { contentType: thumbMime },
        });
        runInBackground(c, () => submitFileScans(c.env.DB, c.env, thumbnailR2Key, thumbMime, thumbnailBuffer));
        thumbnailKey = thumbnailR2Key;
      }
    } else {
      const body = await c.req.json();
      postId = body.postId;
      gifKey = body.gifKey;
      swfKey = body.swfKey;
      text = body.text;
      requestHashtags = body.hashtags || [];
      pollData = body.poll;
      zipKey = body.zipKey;
      thumbnailKey = body.thumbnailKey;
      quotedPostId = body.quotedPostId;
      attachmentInputs = body.attachments;
    }

    if (postId !== undefined && postId !== null && postId !== '' && !isValidPostId(postId)) {
      return c.json({ error: 'Invalid post ID format' }, 422);
    }

    const payloadKey = zipKey;
    const userId = c.get('user')?.id || '';
    const username = c.get('user')?.username || 'anonymous';

    for (const [field, value] of [
      ['gifKey', gifKey],
      ['swfKey', swfKey],
      ['zipKey', zipKey],
      ['thumbnailKey', thumbnailKey],
    ] as const) {
      if (value && !(await isOwnedMediaKey(c.env.DB, userId, value))) {
        return c.json({ error: `Media key ${field} does not belong to this account` }, 422);
      }
    }

    // Validate multi-media attachments (image/audio/video, plan-dependent max)
    if (attachmentInputs !== undefined) {
      const maxAttachments = await resolveAttachmentLimit(c.env, userId);
      const attachmentError = validateAttachmentInputs(attachmentInputs, maxAttachments);
      if (attachmentError) return c.json({ error: attachmentError }, 422);
      if (gifKey || swfKey || payloadKey || thumbnailKey) {
        return c.json({ error: 'Cannot combine attachments with game payloads' }, 422);
      }
    }

    // Reject overwriting another user's post through the upsert path
    if (postId) {
      const existingOwner = (await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ?')
        .bind(postId)
        .first<{ user_id: string }>()) as { user_id: string } | null;
      if (existingOwner && existingOwner.user_id !== userId) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    // Validate text (empty allowed only for quotes)
    const hasQuote = Boolean(quotedPostId);
    if (!text) text = '';
    if (text.length > 200 || (!hasQuote && text.length < 1)) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422);
    }
    const colorError = colorEntitlementError(c, text);
    if (colorError) return colorError;

    // Validate hashtags
    if (!Array.isArray(requestHashtags) || requestHashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422);
    }

    for (const tag of requestHashtags) {
      if (
        typeof tag !== 'string' ||
        tag.length > 20 ||
        !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)
      ) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422);
      }
    }

    // Extract hashtags from text
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
    const hashtagSet = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtagSet.add(match[1]);
    }
    const hashtags = Array.from(hashtagSet);

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    const mentionSet = new Set<string>();
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1]);
    }
    const mentionedUsernames = Array.from(mentionSet);

    // Resolve mentions
    const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username);

    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available');
      return c.json({ error: 'Database not available' }, 500);
    }

    // Validate quoted post reference if provided
    let quotedPostAuthorId: string | null = null;
    if (quotedPostId) {
      const quoted = (await c.env.DB.prepare('SELECT id, user_id, status FROM posts WHERE id = ?')
        .bind(quotedPostId)
        .first()) as { id: string; user_id: string; status: string } | null;

      if (!quoted || quoted.status !== 'published') {
        return c.json({ error: 'Quoted post not found' }, 404);
      }
      quotedPostAuthorId = quoted.user_id;
    }

    if (!postId) postId = crypto.randomUUID();

    // Attachments must target this post and fit the total size budget
    const attachments = attachmentInputs !== undefined ? sequenceAttachments(attachmentInputs) : [];
    if (attachments.length > 0) {
      for (const att of attachments) {
        if (parseAttachmentKey(att.r2_key)?.postId !== postId) {
          return c.json({ error: 'Attachment does not belong to this post' }, 422);
        }
      }
      const budgetError = await attachmentBudget(
        c.env,
        userId,
        attachments.map((a) => a.r2_key),
      );
      if (budgetError) return c.json({ error: budgetError }, 413);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, payload_key, gif_key, swf_key, thumbnail_key, quoted_post_id, engagement_hotness, status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 'published'
      WHERE ? = 0 OR EXISTS (
        SELECT 1 FROM posts prepared
        WHERE prepared.id = ? AND prepared.user_id = ? AND prepared.status IN ('pending', 'published')
      )
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        hashtags = excluded.hashtags,
        mentions = excluded.mentions,
        payload_key = COALESCE(excluded.payload_key, posts.payload_key),
        gif_key = COALESCE(excluded.gif_key, posts.gif_key),
        swf_key = COALESCE(excluded.swf_key, posts.swf_key),
        thumbnail_key = COALESCE(excluded.thumbnail_key, posts.thumbnail_key),
        quoted_post_id = COALESCE(excluded.quoted_post_id, posts.quoted_post_id),
        status = 'published'
      WHERE posts.status != 'reaping'
    `)
      .bind(
        postId,
        userId,
        username,
        text,
        JSON.stringify(hashtags),
        mentionsJson,
        payloadKey || null,
        gifKey || null,
        swfKey || null,
        thumbnailKey || null,
        quotedPostId || null,
        Number(Boolean(gifKey || swfKey || payloadKey || thumbnailKey || attachments.length)),
        postId,
        userId,
      )
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to create post', details: result }, 500);
    }

    if (result.meta.changes === 0) return c.json({ error: 'Post preparation has expired' }, 409);

    // Persist multi-media attachments (full replacement for idempotent commits)
    if (attachments.length > 0) {
      const previous =
        (
          await c.env.DB.prepare('SELECT r2_key FROM post_attachments WHERE post_id = ?')
            .bind(postId)
            .all<{ r2_key: string }>()
        ).results || [];
      const nextKeySet = new Set(attachments.map((a) => a.r2_key));
      const dropped = previous.map((r) => r.r2_key).filter((k) => !nextKeySet.has(k));
      if (dropped.length > 0 && c.env.BUCKET) {
        await Promise.all(dropped.map((k) => c.env.BUCKET.delete(k).catch(() => {})));
      }
      const attStmts = [
        c.env.DB.prepare('DELETE FROM post_attachments WHERE post_id = ?').bind(postId),
        ...attachments.map((att) =>
          c.env.DB.prepare('INSERT INTO post_attachments (post_id, r2_key, kind, position) VALUES (?, ?, ?, ?)').bind(
            postId,
            att.r2_key,
            att.kind,
            att.position,
          ),
        ),
      ];
      await c.env.DB.batch(attStmts);
    }

    // Create poll if poll data was provided
    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      // Cap the batch fan-out: options become one INSERT each plus one poll row.
      if (pollData.options.length > 10) {
        return c.json({ error: 'Polls support at most 10 options' }, 400);
      }
      if (typeof pollData.question !== 'string' || pollData.question.length > 200) {
        return c.json({ error: 'Poll question must be ≤200 characters' }, 400);
      }
      for (const label of pollData.options) {
        if (typeof label !== 'string' || label.length === 0 || label.length > 100) {
          return c.json({ error: 'Poll options must be 1–100 characters' }, 400);
        }
      }
      try {
        const pollId = crypto.randomUUID();
        await c.env.DB.prepare(`
          INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(pollId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null)
          .run();

        const optionIds: string[] = [];
        const optionStmts = pollData.options.map((label: string) => {
          const optId = crypto.randomUUID();
          optionIds.push(optId);
          return c.env.DB.prepare('INSERT INTO poll_options (id, poll_id, label) VALUES (?, ?, ?)').bind(
            optId,
            pollId,
            label,
          );
        });
        await c.env.DB.batch(optionStmts);
      } catch (e) {
        console.error('Failed to create poll:', e);
        // Don't fail post creation if poll creation fails
      }
    }

    // Create mention notifications for mentioned users (skip self-mentions, quoted author, and duplicates)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{ username: string; user_id: string }>;
        const seenMentionUserIds = new Set<string>();
        const mentionTargets = mentionData.filter((m) => {
          if (m.user_id === userId) return false;
          // The quoted post author gets a dedicated 'quote' notification below.
          if (m.user_id === quotedPostAuthorId) return false;
          if (seenMentionUserIds.has(m.user_id)) return false;
          seenMentionUserIds.add(m.user_id);
          return true;
        });
        const mentionStmts = mentionTargets.map((m) =>
          c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          ).bind(nanoid(), m.user_id, 'mention', postId, userId),
        );
        if (mentionStmts.length > 0) {
          await c.env.DB.batch(mentionStmts);
        }
        const actor = c.get('user');
        for (const mention of mentionTargets) {
          waitUntil(
            c,
            () =>
              sendPushToAll(
                c.env,
                mention.user_id,
                'mention',
                actor?.username,
                actor?.display_name,
                text || '',
                postId,
              ),
            'Failed to send mention push',
          );
        }
      } catch (e) {
        // Don't fail the post creation if mention notifications fail
        console.error('Failed to create mention notifications:', e);
      }
    }

    // Create quote notification for the quoted post's author (skip self-quotes)
    if (quotedPostAuthorId && quotedPostAuthorId !== userId) {
      try {
        await c.env.DB.prepare(
          'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(nanoid(), quotedPostAuthorId, 'quote', postId, userId)
          .run();
        const actor = c.get('user');
        waitUntil(
          c,
          () =>
            sendPushToAll(c.env, quotedPostAuthorId, 'quote', actor?.username, actor?.display_name, text || '', postId),
          'Failed to send quote push',
        );
      } catch (e) {
        console.error('Failed to create quote notification:', e);
      }
    }

    // ActivityPub delivery for public posts
    try {
      const user = (await c.env.DB.prepare('SELECT id, username, display_name FROM users WHERE id = ?')
        .bind(userId)
        .first()) as { id: string; username: string; display_name: string } | null;

      if (user) {
        const post = (await c.env.DB.prepare(
          'SELECT id, text, created_at, status, mentions, gif_key, payload_key, swf_key FROM posts WHERE id = ?',
        )
          .bind(postId)
          .first()) as {
          id: string;
          text: string;
          created_at: string;
          status: string;
          mentions: string | null;
          gif_key: string | null;
          payload_key: string | null;
          swf_key: string | null;
        } | null;
        if (post && post.status === 'published') {
          // Mentioned accounts are addressed directly; everyone else is via followers.
          let mentions: Array<{ username: string; url: string }> = [];
          try {
            if (post.mentions) {
              const mentionData = JSON.parse(post.mentions) as Array<{ username: string; user_id: string }>;
              mentions = mentionData.map((m) => ({
                username: m.username,
                url: `${c.env.BASE_URL}/api/actors/${m.username}`,
              }));
            }
          } catch {}
          const note = buildNoteObject(
            {
              id: post.id,
              text: post.text,
              created_at: post.created_at,
              visibility: 'public',
              mentions,
              attachments: await loadNoteAttachments(c.env.DB, post.id, c.env.BASE_URL, post),
            },
            user,
            c.env.BASE_URL,
            { followersUrl: `${c.env.BASE_URL}/api/actors/${user.username}/followers` },
          );
          const activity = buildCreateActivity(note, user, c.env.BASE_URL);

          // One delivery per remote inbox (a shared inbox expects one activity).
          // Federation is not needed to answer the publish request; keep it
          // alive after the response instead of blocking the click.
          waitUntil(c, () => deliverToFollowers(c.env, { userId, username, activity }), 'ActivityPub delivery failed');
        }
      }
    } catch (e) {
      // Queue not available or other error - skip delivery in development
      console.error('ActivityPub delivery skipped:', String(e));
    }

    // Extract game description from ZIP
    if (payloadKey && payloadKey.endsWith('.zip')) {
      await extractGameDescription(c.env.BUCKET, c.env.DB, payloadKey!, postId!);
    }

    // Fetch the created post for enrichment
    const fullPost = (await c.env.DB.prepare(
      "SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.game_description, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN titles t ON t.id = u.equipped_title_id WHERE p.id = ?",
    )
      .bind(postId)
      .first()) as PostRow;

    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      // Cap the batch fan-out: options become one INSERT each plus one poll row.
      if (pollData.options.length > 10) {
        return c.json({ error: 'Polls support at most 10 options' }, 400);
      }
      if (typeof pollData.question !== 'string' || pollData.question.length > 200) {
        return c.json({ error: 'Poll question must be ≤200 characters' }, 400);
      }
      for (const label of pollData.options) {
        if (typeof label !== 'string' || label.length === 0 || label.length > 100) {
          return c.json({ error: 'Poll options must be 1–100 characters' }, 400);
        }
      }
      try {
        await enrichPostsWithPolls([fullPost], c.env.DB, c.get('user')?.id);
      } catch (e) {
        console.error('Failed to enrich post with poll:', e);
      }
    }

    await enrichPostsWithQuotes([fullPost], c.env.DB);
    await enrichPostsWithAttachments([fullPost], c.env.DB);
    await enrichPostsWithReactions([fullPost], c.env.DB, c.get('user')?.id);

    await refreshUserTrustSafe(c.env.DB, userId);

    // Media for multimodal embed + AI tagging: game posts contribute their
    // thumbnail, attachments contribute image/audio/video keys.
    const media: PostMediaInput = {
      imageKeys: [
        ...(isImageKey(fullPost.gif_key) ? [fullPost.gif_key] : []),
        ...(isImageKey(fullPost.thumbnail_key) ? [fullPost.thumbnail_key] : []),
        ...imageAttachmentKeys(fullPost.attachments),
      ],
      audioKey: (fullPost.attachments as Array<AttachmentRecord> | undefined)?.find((a) => a.kind === 'audio')?.r2_key,
      videoKey: (fullPost.attachments as Array<AttachmentRecord> | undefined)?.find((a) => a.kind === 'video')?.r2_key,
    };
    const hasMedia = (media.imageKeys?.length ?? 0) > 0 || Boolean(media.audioKey) || Boolean(media.videoKey);

    runInBackground(
      c,
      () => embedPost(c.env.DB, c.env, fullPost.id, fullPost.text, hasMedia ? media : undefined),
      'Background embed failed',
    );
    runInBackground(
      c,
      () => tagPost(c.env.DB, c.env, fullPost.id, fullPost.text, hasMedia ? media : undefined),
      'Background AI tag failed',
    );

    // Screen every image the post carries, not just the first: reconcile the
    // scan rows with the current key list, then submit what the throttle allows.
    screenPostImages(c.env.DB, c.env, fullPost.id, [
      ...(isImageKey(fullPost.gif_key) ? [fullPost.gif_key] : []),
      ...imageAttachmentKeys(fullPost.attachments),
    ]).catch((e) => console.error('Background NSFW screen failed:', e));

    // Pre-extract ZIP to R2 for WVFS persistent caching
    if (payloadKey && payloadKey.endsWith('.zip')) {
      const execCtx = (c as any).executionCtx;
      if (execCtx?.waitUntil) {
        execCtx.waitUntil(
          (async () => {
            try {
              await extractZipToR2(c.env.BUCKET, payloadKey!, postId!);
            } catch (e) {
              console.error('Background ZIP extraction failed:', e);
            }
          })(),
        );
      }
    }

    // Pre-copy HTML to WVFS for persistent caching
    if (payloadKey && payloadKey.endsWith('.html')) {
      const execCtx = (c as any).executionCtx;
      if (execCtx?.waitUntil) {
        execCtx.waitUntil(
          (async () => {
            try {
              await copyHtmlToWvfs(c.env.BUCKET, payloadKey!, postId!);
            } catch (e) {
              console.error('Background HTML copy failed:', e);
            }
          })(),
        );
      }
    }

    return c.json({ post: fullPost });
  } catch (error: unknown) {
    console.error('Post creation error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /api/posts/:id/fresh - toggle Fresh! (protected)
