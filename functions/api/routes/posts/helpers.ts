import { enrichPostsWithRemoteAuthors } from '../../../lib/activitypub/authors';
import { enrichPostsWithAttachments } from '../../../lib/attachments';
import { enrichPostsWithPolls, enrichPostsWithQuotes, enrichPostsWithReactions } from '../../feed-enrichment';
import { batchGetFreshAndBookmarkStatus } from '../../helpers';
import type { PostRow } from '../../types';

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
