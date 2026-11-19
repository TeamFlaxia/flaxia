import { type Context } from 'hono';
import { canUsePostColors } from '../../../../shared/entitlements.ts';
import { hasPostColors } from '../../../../shared/post-colors.ts';
import { enrichPostsWithRemoteAuthors } from '../../../lib/activitypub/authors';
import {
  enrichPostsWithAttachments,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_PLUS,
  parseAttachmentKey,
} from '../../../lib/attachments';
import { getUserPlan } from '../../../lib/billing';
import { enrichPostsWithPolls, enrichPostsWithQuotes, enrichPostsWithReactions } from '../../feed-enrichment';
import { batchGetFreshAndBookmarkStatus } from '../../helpers';
import type { Bindings, PostRow, Variables } from '../../types';

export const POST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidPostId(value: unknown): value is string {
  return typeof value === 'string' && POST_ID_PATTERN.test(value);
}

export const LEGACY_MEDIA_KEY_RE =
  /^(?:gif|audio|video|payload|swf|zip|html|thumbnail)\/([A-Za-z0-9_-]{1,64})(?:\..+)?$/;
export const VERSION_MEDIA_KEY_RE = /^versions\/([A-Za-z0-9_-]{1,64})\//;

/**
 * True when a client-supplied R2 key names one of the caller's own posts.
 *
 * Without this, a request could attach another user's object to its own post
 * (hotlink/misattribution) or, worse, pass the victim's key on an edit so the
 * cleanup path deletes it from R2.
 */
export async function isOwnedMediaKey(db: D1Database, userId: string, key: unknown): Promise<boolean> {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) return false;
  const attachment = parseAttachmentKey(key);
  let postId: string | null = attachment?.postId ?? null;
  if (!postId) postId = key.match(LEGACY_MEDIA_KEY_RE)?.[1] ?? null;
  if (!postId) postId = key.match(VERSION_MEDIA_KEY_RE)?.[1] ?? null;
  if (!postId) return false;
  const row = await db
    .prepare("SELECT id FROM posts WHERE id = ? AND user_id = ? AND status IN ('pending', 'published')")
    .bind(postId, userId)
    .first();
  return Boolean(row);
}

// Step 3 — POST /api/posts/commit (protected)

export async function resolveAttachmentLimit(env: Bindings, userId: string): Promise<number> {
  if (!userId) return MAX_ATTACHMENTS;
  const plan = await getUserPlan(env, userId);
  return plan.isActive ? MAX_ATTACHMENTS_PLUS : MAX_ATTACHMENTS;
}

/** Text colors are a Flaxia+ (or reviewer) entitlement. */
export function colorEntitlementError(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  text: string,
): Response | null {
  if (canUsePostColors(c.get('user')) || !hasPostColors(text)) return null;
  return c.json({ error: 'flaxia_plus_required', message: 'Text colors and styles require Flaxia+' }, 403);
}

export async function ensureReactionsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS reactions (
           post_id    TEXT NOT NULL,
           user_id    TEXT NOT NULL,
           emoji      TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           PRIMARY KEY (post_id, user_id, emoji)
         )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id)').run();
  } catch (e) {
    console.error('Failed to ensure reactions table:', e);
  }
}

export const RECOMMENDED_SELECT = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
  COALESCE(p.reply_count, 0) as reply_count, 
  COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at`;

export async function enrichFeedPosts(posts: PostRow[], db: D1Database, currentUserId?: string | null): Promise<void> {
  if (posts.length === 0) return;

  // These batch lookups update separate fields, so overlap their D1 latency.
  await Promise.all([
    (async () => {
      if (!currentUserId) return;
      const postIds = posts.map((post) => String(post.id));
      const { freshed, reloaded, bookmarked } = await batchGetFreshAndBookmarkStatus(db, currentUserId, postIds);
      posts.forEach((post) => {
        post.is_freshed = freshed.has(post.id);
        post.is_reloaded = reloaded.has(post.id);
        post.is_bookmarked = bookmarked.has(post.id);
      });
    })(),
    enrichPostsWithPolls(posts, db, currentUserId),
    enrichPostsWithQuotes(posts, db),
    enrichPostsWithAttachments(posts, db),
    enrichPostsWithReactions(posts, db, currentUserId),
  ]);
  await enrichPostsWithRemoteAuthors(posts as Array<Record<string, unknown>>, db);
}

export async function autoRestoreIfEligible(db: D1Database, postId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `SELECT id FROM counter_notifications
         WHERE post_id = ? AND status = 'pending' AND restore_at IS NOT NULL AND restore_at <= ?`,
      )
      .bind(postId, now)
      .first();

    if (result) {
      await db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(postId).run();
      await db
        .prepare("UPDATE counter_notifications SET status = ? WHERE post_id = ? AND status = 'pending'")
        .bind('auto_restored', postId)
        .run();
      console.log(`Auto-restored post ${postId} after counter-notification period`);
    }
  } catch (err) {
    console.error('Auto-restore check failed:', err);
  }
}

// POST /api/posts/:id/counter-notice - file a DMCA counter-notification (protected)
