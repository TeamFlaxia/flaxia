import type { Context } from 'hono';
import { nanoid } from 'nanoid';
import { buildUpdateActivity } from '../../../lib/activitypub/activities';
import { buildActorDocument } from '../../../lib/activitypub/actor';
import { deliverToFollowers } from '../../../lib/activitypub/delivery';
import { ensureActorKey } from '../../../lib/activitypub/keys';
import { runInBackground } from '../../../lib/scan/index';
import { fetchWithSsrfGuard, parsePublicHttpUrl } from '../../../lib/url-guard';
import type { Bindings, PostRow, Variables } from '../../types';

/**
 * Announce a changed actor document to federated followers.
 *
 * Mastodon caches a remote account until it receives an `Update`: a profile
 * edit that is never announced stays invisible to every instance that already
 * knows the account (old name, old bio, old status count). Delivery is
 * best-effort and runs after the response.
 */
export function deliverProfileUpdate(c: Context<{ Bindings: Bindings; Variables: Variables }>, userId: string): void {
  runInBackground(
    c,
    async () => {
      const row = await c.env.DB.prepare(
        'SELECT username, display_name, bio, avatar_key, created_at FROM users WHERE id = ?',
      )
        .bind(userId)
        .first<{
          username: string;
          display_name: string | null;
          bio: string | null;
          avatar_key: string | null;
          created_at: string | null;
        }>();
      if (!row) return;

      const publicKeyPem = await ensureActorKey(c.env.DB, userId);
      const actor = buildActorDocument({ baseUrl: c.env.BASE_URL, user: row, publicKeyPem });
      const activity = buildUpdateActivity(c.env.BASE_URL, row.username, actor, nanoid());

      await deliverToFollowers(c.env, {
        userId,
        username: row.username,
        activity,
      });
    },
    'Profile update delivery failed',
  );
}

/**
 * Fetch a JSON document from a URL that ultimately came from user input or a
 * remote server. validate + timeout + no redirect surprises beyond the policy
 * in url-guard; callers map SsrfError to a 400.
 */
export async function fetchRemoteJson(url: string, accept: string): Promise<{ url: string; response: Response }> {
  const parsed = parsePublicHttpUrl(url);
  // Follow redirects hop-by-hop through the guard so a remote server cannot
  // bounce this fetch to localhost or a private range.
  const response = await fetchWithSsrfGuard(parsed.toString(), {
    headers: { Accept: accept },
    timeoutMs: 10_000,
  });
  return { url: parsed.toString(), response };
}

export const RECOMMENDED_SELECT = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
  COALESCE(p.reply_count, 0) as reply_count, 
  COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at`;

export async function enrichPostsWithReactions(
  posts: PostRow[],
  db: D1Database,
  currentUserId?: string | null,
): Promise<void> {
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.id);
  const placeholders = postIds.map(() => '?').join(',');

  const summaryResult = await db
    .prepare(
      `SELECT post_id, emoji, COUNT(*) AS count FROM reactions
       WHERE post_id IN (${placeholders})
       GROUP BY post_id, emoji`,
    )
    .bind(...postIds)
    .all<{ post_id: string; emoji: string; count: number }>();

  const mine = new Set<string>();
  if (currentUserId) {
    const mineResult = await db
      .prepare(`SELECT post_id, emoji FROM reactions WHERE user_id = ? AND post_id IN (${placeholders})`)
      .bind(currentUserId, ...postIds)
      .all<{ post_id: string; emoji: string }>();
    for (const r of mineResult.results || []) {
      mine.add(`${r.post_id}:${r.emoji}`);
    }
  }

  const stampNames = new Set<string>();
  for (const row of summaryResult.results || []) {
    if (/^:.+:$/.test(row.emoji)) {
      stampNames.add(row.emoji);
    }
  }

  const stampUrlMap = new Map<string, string>();
  if (stampNames.size > 0) {
    const stampRows = await db
      .prepare(
        `SELECT name, image_key FROM custom_stamps WHERE name IN (${Array.from(stampNames)
          .map(() => '?')
          .join(',')})`,
      )
      .bind(...stampNames)
      .all<{ name: string; image_key: string }>();
    for (const s of stampRows.results || []) {
      stampUrlMap.set(s.name, `/api/images/${s.image_key}`);
    }
  }

  const grouped = new Map<string, Array<{ emoji: string; count: number; reacted: boolean; stamp_url?: string }>>();
  for (const row of summaryResult.results || []) {
    if (!grouped.has(row.post_id)) grouped.set(row.post_id, []);
    const entry: { emoji: string; count: number; reacted: boolean; stamp_url?: string } = {
      emoji: row.emoji,
      count: row.count,
      reacted: mine.has(`${row.post_id}:${row.emoji}`),
    };
    const stampUrl = stampUrlMap.get(row.emoji);
    if (stampUrl) entry.stamp_url = stampUrl;
    grouped.get(row.post_id)!.push(entry);
  }

  for (const post of posts) {
    post.reactions = grouped.get(post.id) || [];
  }
}

// GET /users/suggestions - get user suggestions for "who to follow"
