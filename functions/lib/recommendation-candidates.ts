// Pure candidate-selection helpers for the For You feed. Kept out of the HTTP
// route so the handler stays within the file-size ratchet and the ranking
// maths can be unit-tested without a dev server.

import { POOL_JOIN_SQL, POOL_SCORE_SQL } from './activitypub/ap-pool.ts';
import { EXACT_DUPLICATE_FILTER } from './post-visibility.ts';
import type { ActionSignals } from './recommendation-scoring.ts';
import { RECOMMENDATION_MIN_TRUST } from './trust.ts';

export const RECENT_CANDIDATE_WINDOW_HOURS = 72;
export const TRENDING_CANDIDATE_WINDOW_DAYS = 14;
export const CLIENT_RANK_VECTOR_BATCH_MAX = 120;

export const RECOMMENDATION_TRUST_FILTER = `AND COALESCE(u.trust_score, 1.0) >= ${RECOMMENDATION_MIN_TRUST}`;
// For You is local-only. Remote rows (which carry an actor id) belong to the
// Federated tab; excluding them at the source keeps them out of candidate slots.
export const LOCAL_ONLY_FILTER = 'AND p.actor_id IS NULL';

// Engagement source: a bounded log-ish trending formula. `?` is the current
// time in Unix seconds and is always bound before the other query parameters.
export const ENGAGEMENT_FORMULA = `MAX(COALESCE(p.engagement_hotness, 0), p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + COALESCE(p.bookmark_count, 0) * 2.0 + 1.0) / EXP(1.2 * LN(MAX(0.0, (? - unixepoch(p.created_at)) / 3600.0) + 2.0))`;

export interface ScoredPost {
  post: Record<string, unknown>;
  score: number;
}

export function buildPoolCandidateSql(filterSql: string): string {
  return `SELECT p.id, ${POOL_SCORE_SQL} AS pool_score
    FROM posts p ${POOL_JOIN_SQL}
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.actor_id IS NOT NULL AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
      ${filterSql} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
    ORDER BY pool_score DESC LIMIT ?`;
}

export function diversifyPosts(items: ScoredPost[], maxCount: number, maxPerUser: number): ScoredPost[] {
  const userCounts = new Map<string, number>();
  const result: ScoredPost[] = [];
  for (const item of items) {
    if (result.length >= maxCount) break;
    // Remote posts share an empty user_id; key by actor so one federated
    // author cannot take every slot (and so they are not capped to 2 total).
    const authorId = String(item.post.actor_id || item.post.user_id || '');
    const count = userCounts.get(authorId) || 0;
    if (count >= maxPerUser) continue;
    userCounts.set(authorId, count + 1);
    result.push(item);
  }
  return result;
}

export function compareScoredPosts(a: ScoredPost, b: ScoredPost): number {
  const diff = b.score - a.score;
  if (diff !== 0) return diff;
  const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
  if (ca !== 0) return ca;
  return String(b.post.id || '').localeCompare(String(a.post.id || ''));
}

/** Author language is already selected by RECOMMENDED_SELECT as author_language. */
export function languageAffinity(post: Record<string, unknown>, viewerLanguage: string): number {
  if (!viewerLanguage) return 0;
  const authorLanguage = String(post.author_language ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 2);
  return authorLanguage === viewerLanguage ? 1 : 0;
}

export function rankCandidateIds(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]));
}

export function candidateRankScore(id: string, ranks: Map<string, number>): number {
  const rank = ranks.get(id);
  return rank === undefined ? 0 : 1 / (1 + rank / 20);
}

export function decayingRecommendationPenalty(
  activityAt: string | null | undefined,
  asOfMs: number,
  maxPenalty: number,
  halfLifeDays: number,
): number {
  if (!activityAt) return 0;
  const activityMs = Date.parse(activityAt);
  if (!Number.isFinite(activityMs)) return 0;
  const ageMs = Math.max(0, asOfMs - activityMs);
  return maxPenalty * 2 ** (-ageMs / (halfLifeDays * 86400_000));
}

/**
 * `reload_count` is Flaxia's repost counter and is *not* part of the
 * popularity formula (which uses fresh/reply/bookmark counts and impressions),
 * so it can feed the `share` action signal without double-counting.
 * The other per-action predictions need viewer-level engagement history that
 * this feed does not hydrate yet; they stay zero for now.
 */
export function deriveActionSignals(post: Record<string, unknown>, maxReloads: number): ActionSignals {
  const reloads = Math.max(0, Number(post.reload_count) || 0);
  return { share: maxReloads > 0 ? Math.min(1, reloads / maxReloads) : 0 };
}
