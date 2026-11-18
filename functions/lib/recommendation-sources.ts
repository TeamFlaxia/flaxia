/// <reference types="@cloudflare/workers-types" />

import type { FeedOrigin } from './feed-mix.ts';
import { EXACT_DUPLICATE_FILTER } from './post-visibility.ts';
import { RECOMMENDATION_MIN_TRUST } from './trust.ts';

/**
 * Shared candidate loading for the recommendation feed.
 *
 * Both origins are queried with the same limit, so a feed that is mostly
 * local cannot push every external post out of the candidate window. The
 * caller then interleaves the two streams with `mixFeedOrigins`.
 */

/** Posts younger than this are eligible for the recent source. */
export const RECENT_CANDIDATE_WINDOW_HOURS = 72;

/** Posts younger than this are eligible for the trending source. */
export const TRENDING_CANDIDATE_WINDOW_DAYS = 14;

export const RECOMMENDED_SELECT = `SELECT p.id, p.user_id, p.actor_id, p.username, u.display_name, u.avatar_key, u.badge_type, u.name_color, u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja, t.icon AS title_icon, u.language as author_language, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reload_count, 0) as reload_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
  COALESCE(p.reply_count, 0) as reply_count, 
  COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at`;

export const RECOMMENDATION_TRUST_FILTER = `AND COALESCE(u.trust_score, 1.0) >= ${RECOMMENDATION_MIN_TRUST}`;

export const RECOMMENDATION_ENGAGEMENT_FORMULA = `MAX(COALESCE(p.engagement_hotness, 0), p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + COALESCE(p.bookmark_count, 0) * 2.0 + 1.0) / EXP(1.2 * LN(MAX(0.0, (? - unixepoch(p.created_at)) / 3600.0) + 2.0))`;

export interface RecommendationSourceRows {
  recentLocal: Record<string, unknown>[];
  recentExternal: Record<string, unknown>[];
  trendingLocal: Record<string, unknown>[];
  trendingExternal: Record<string, unknown>[];
  following: Record<string, unknown>[];
  asOfIso: string;
  trendingCutoff: string;
  asOfUnixSeconds: number;
}

export async function loadRecommendationSourceRows(
  db: D1Database,
  currentUserId: string | null,
  sourceLimit: number,
  asOfMs: number,
): Promise<RecommendationSourceRows> {
  const asOfIso = new Date(asOfMs).toISOString();
  const asOfUnixSeconds = Math.floor(asOfMs / 1000);
  const recentCutoff = new Date(asOfMs - RECENT_CANDIDATE_WINDOW_HOURS * 3600_000).toISOString();
  const trendingCutoff = new Date(asOfMs - TRENDING_CANDIDATE_WINDOW_DAYS * 86400_000).toISOString();
  const visibilityFilter = currentUserId
    ? 'AND p.user_id != ? AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)'
    : '';
  const visibilityParams: string[] = currentUserId ? [currentUserId, currentUserId] : [];

  const recentQuery = (
    origin: FeedOrigin,
  ): string => `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN titles t ON t.id = u.equipped_title_id
    WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
      AND p.user_id ${origin === 'local' ? "!= ''" : "= ''"}
      ${visibilityFilter} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
    ORDER BY p.created_at DESC LIMIT ?`;

  const trendingQuery = (
    origin: FeedOrigin,
  ): string => `${RECOMMENDED_SELECT}, (${RECOMMENDATION_ENGAGEMENT_FORMULA}) as eng_score
    FROM posts p LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN titles t ON t.id = u.equipped_title_id
    WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
      AND p.user_id ${origin === 'local' ? "!= ''" : "= ''"}
      ${visibilityFilter} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
    ORDER BY eng_score DESC, p.created_at DESC LIMIT ?`;

  const followingQuery = `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN titles t ON t.id = u.equipped_title_id
    WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
      AND p.created_at >= ? AND p.created_at <= ?
      AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = p.user_id)
      ${visibilityFilter} ${RECOMMENDATION_TRUST_FILTER}
    ORDER BY p.created_at DESC LIMIT ?`;

  const [recentLocal, recentExternal, trendingLocal, trendingExternal, following] = await Promise.all([
    db
      .prepare(recentQuery('local'))
      .bind(...visibilityParams, recentCutoff, asOfIso, sourceLimit)
      .all<Record<string, unknown>>(),
    db
      .prepare(recentQuery('external'))
      .bind(...visibilityParams, recentCutoff, asOfIso, sourceLimit)
      .all<Record<string, unknown>>(),
    db
      .prepare(trendingQuery('local'))
      .bind(asOfUnixSeconds, ...visibilityParams, trendingCutoff, asOfIso, sourceLimit)
      .all<Record<string, unknown>>(),
    db
      .prepare(trendingQuery('external'))
      .bind(asOfUnixSeconds, ...visibilityParams, trendingCutoff, asOfIso, sourceLimit)
      .all<Record<string, unknown>>(),
    currentUserId
      ? db
          .prepare(followingQuery)
          .bind(trendingCutoff, asOfIso, currentUserId, ...visibilityParams, sourceLimit)
          .all<Record<string, unknown>>()
      : Promise.resolve(null),
  ]);

  return {
    recentLocal: recentLocal.results ?? [],
    recentExternal: recentExternal.results ?? [],
    trendingLocal: trendingLocal.results ?? [],
    trendingExternal: trendingExternal.results ?? [],
    following: following?.results ?? [],
    asOfIso,
    trendingCutoff,
    asOfUnixSeconds,
  };
}
