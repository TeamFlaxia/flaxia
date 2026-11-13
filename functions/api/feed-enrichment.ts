import { enrichPostsWithAttachments } from '../lib/attachments';
import { batchGetFreshAndBookmarkStatus } from './helpers';
import type { PollOptionRow, PollRow, PostRow } from './types';

/**
 * Feed-shaped enrichment shared by the timeline, search, and any other endpoint
 * that returns posts rendered with PostCard. Keeping this in one place prevents
 * search results from drifting from the timeline (missing reactions, quotes,
 * polls, fresh/bookmark state, or attachments).
 */
export async function enrichPostsForFeed(
  posts: PostRow[],
  db: D1Database,
  currentUserId?: string | null,
): Promise<void> {
  if (posts.length === 0) return;

  await Promise.all([
    (async () => {
      if (!currentUserId) return;
      const postIds = posts.map((post) => String(post.id));
      const { freshed, reloaded, bookmarked } = await batchGetFreshAndBookmarkStatus(db, currentUserId, postIds);
      for (const post of posts) {
        post.is_freshed = freshed.has(String(post.id));
        post.is_reloaded = reloaded.has(String(post.id));
        post.is_bookmarked = bookmarked.has(String(post.id));
      }
    })(),
    enrichPostsWithPolls(posts, db, currentUserId),
    enrichPostsWithQuotes(posts, db),
    enrichPostsWithAttachments(posts, db),
    enrichPostsWithReactions(posts, db, currentUserId),
  ]);
}

export async function enrichPostsWithPolls(
  posts: PostRow[],
  db: D1Database,
  currentUserId?: string | null,
): Promise<void> {
  if (posts.length === 0) return;
  const postIds = posts.map((p) => p.id);
  const placeholders = postIds.map(() => '?').join(',');
  const pollsResult = await db
    .prepare(`SELECT * FROM polls WHERE post_id IN (${placeholders})`)
    .bind(...postIds)
    .all<PollRow>();

  if (!pollsResult.success || pollsResult.results.length === 0) return;

  const pollMap = new Map<string, PollRow>();
  for (const poll of pollsResult.results) {
    pollMap.set(poll.post_id, poll);
  }

  const pollIds = pollsResult.results.map((p: PollRow) => p.id);
  const optPlaceholders = pollIds.map(() => '?').join(',');

  // Parallelize poll options and user votes queries
  const [optsResult, votesResult] = await Promise.all([
    db
      .prepare(`SELECT * FROM poll_options WHERE poll_id IN (${optPlaceholders}) ORDER BY rowid`)
      .bind(...pollIds)
      .all<PollOptionRow>(),
    currentUserId
      ? db
          .prepare(`SELECT poll_id, option_id FROM poll_votes WHERE poll_id IN (${optPlaceholders}) AND user_id = ?`)
          .bind(...pollIds, currentUserId)
          .all<{ poll_id: string; option_id: string }>()
      : Promise.resolve({ success: true, results: [] as Array<{ poll_id: string; option_id: string }> }),
  ]);

  const optsByPoll = new Map<string, PollOptionRow[]>();
  if (optsResult.success) {
    for (const opt of optsResult.results) {
      const pid = opt.poll_id;
      if (!optsByPoll.has(pid)) optsByPoll.set(pid, []);
      optsByPoll.get(pid)!.push(opt);
    }
  }

  const userVotes = new Map<string, string>();
  if (votesResult.success) {
    for (const v of votesResult.results) {
      userVotes.set(v.poll_id, v.option_id);
    }
  }

  for (const post of posts) {
    const poll = pollMap.get(post.id);
    if (poll) {
      const now = new Date();
      const endsAt = poll.ends_at || null;
      const expired = endsAt ? new Date(endsAt) <= now : false;
      post.poll = {
        id: poll.id,
        question: poll.question,
        multipleChoice: !!poll.multiple_choice,
        endsAt,
        options: optsByPoll.get(poll.id) || [],
        userVote: userVotes.get(poll.id) || null,
        expired,
      };
    }
  }
}

/** Quoted post row: the SELECT shape plus an index signature for enrichment. */
type QuotedPostRow = {
  id: string;
  status: string;
  hidden: number | null;
  [key: string]: unknown;
};

/**
 * Batch-fetch quoted posts referenced by the given posts and attach them as
 * `quoted_post`. Only embeds 1 level deep (never recurses) to avoid infinite
 * nesting. Deleted/hidden/absent quoted posts are set to null so the client can
 * render a "post unavailable" placeholder.
 */
export async function enrichPostsWithQuotes(posts: PostRow[], db: D1Database): Promise<void> {
  if (posts.length === 0) return;

  const postIds = posts.map((p) => p.id);
  const idPlaceholders = postIds.map(() => '?').join(',');
  const linksResult = await db
    .prepare(`SELECT id, quoted_post_id FROM posts WHERE id IN (${idPlaceholders}) AND quoted_post_id IS NOT NULL`)
    .bind(...postIds)
    .all<{ id: string; quoted_post_id: string }>();

  const links = linksResult.results || [];
  const quotedIds = [...new Set(links.map((r) => r.quoted_post_id))];
  const quotedMap = new Map<string, QuotedPostRow>();

  if (quotedIds.length > 0) {
    const placeholders = quotedIds.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language,
              p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key,
              p.thumbnail_key, p.parent_id, p.root_id, COALESCE(p.depth, 0) AS depth,
              COALESCE(p.status, 'published') AS status, p.hidden, p.created_at
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.id IN (${placeholders})`,
      )
      .bind(...quotedIds)
      .all<QuotedPostRow>();

    const visible = (result.results || []).filter((quoted) => quoted.status === 'published' && !quoted.hidden);
    for (const quoted of visible) {
      quotedMap.set(quoted.id, quoted);
    }
    // Quote cards render attachments, so the quoted post needs the same
    // enrichment the timeline gives its own posts.
    await enrichPostsWithAttachments(visible, db);
  }

  for (const post of posts) {
    const link = links.find((r) => r.id === post.id);
    post.quoted_post_id = link?.quoted_post_id ?? null;
    post.quoted_post = link ? quotedMap.get(link.quoted_post_id) || null : null;
  }
}

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

  // Collect unique custom stamp names used in reactions
  const stampNames = new Set<string>();
  for (const row of summaryResult.results || []) {
    if (/^:.+:$/.test(row.emoji)) {
      stampNames.add(row.emoji);
    }
  }

  // Resolve custom stamp names to image URLs
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
