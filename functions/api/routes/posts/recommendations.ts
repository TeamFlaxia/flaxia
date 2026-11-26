import { Hono } from 'hono';
import { stripPostColors } from '../../../../shared/post-colors.ts';
import { presentForYou } from '../../../../shared/recommendation/mix.ts';
import {
  type EncodedVector,
  encodeVector,
  RECOMMENDATION_VECTOR_DIM,
} from '../../../../shared/recommendation/vector-codec.ts';
import { POOL_JOIN_SQL, POOL_SCORE_SQL } from '../../../lib/activitypub/ap-pool.ts';
import { clampLimit } from '../../../lib/pagination';
import { EXACT_DUPLICATE_FILTER } from '../../../lib/post-visibility';
import { computeQualityScore } from '../../../lib/scoring';
import { RECOMMENDATION_MIN_TRUST } from '../../../lib/trust';
import type { Bindings, PostRow, Variables } from '../../types';

import { enrichFeedPosts, RECOMMENDED_SELECT, visibilityFilter } from './helpers.ts';

export const recommendations = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function diversifyPosts(
  items: Array<{ post: Record<string, unknown>; score: number }>,
  maxCount: number,
  maxPerUser: number,
): Array<{ post: Record<string, unknown>; score: number }> {
  const userCounts = new Map<string, number>();
  const result: Array<{ post: Record<string, unknown>; score: number }> = [];
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

// Independent sources keep the feed useful while embeddings are pending or a
// user has not built an interest profile yet.
const RECENT_CANDIDATE_WINDOW_HOURS = 72;
const TRENDING_CANDIDATE_WINDOW_DAYS = 14;

function compareScoredPosts(
  a: { post: Record<string, unknown>; score: number },
  b: { post: Record<string, unknown>; score: number },
): number {
  const diff = b.score - a.score;
  if (diff !== 0) return diff;
  const ca = String(b.post.created_at || '').localeCompare(String(a.post.created_at || ''));
  if (ca !== 0) return ca;
  return String(b.post.id || '').localeCompare(String(a.post.id || ''));
}

function rankCandidateIds(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]));
}

function candidateRankScore(id: string, ranks: Map<string, number>): number {
  const rank = ranks.get(id);
  return rank === undefined ? 0 : 1 / (1 + rank / 20);
}

function decayingRecommendationPenalty(
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

const RECOMMENDATION_TRUST_FILTER = `AND COALESCE(u.trust_score, 1.0) >= ${RECOMMENDATION_MIN_TRUST}`;
const CLIENT_RANK_VECTOR_BATCH_MAX = 120;

/**
 * Federated popularity is a small nudge, never a takeover: a log scale keeps
 * viral remote posts bounded and the bounded weight keeps them behind equally
 * good local candidates before the 50:50 presentation mix.
 */
export const POOL_SCORE_WEIGHT = 0.08;

export function normalizePoolScore(poolScore: number | null | undefined): number {
  if (typeof poolScore !== 'number' || !Number.isFinite(poolScore) || poolScore <= 0) return 0;
  return Math.min(1, Math.log1p(poolScore) / Math.log1p(50));
}

export interface CandidateScoreInput {
  sourceScore: number;
  popularity: number;
  freshness: number;
  contentQuality: number;
  /** Raw `ap_pool_metrics.score`; local posts have no row and score zero. */
  poolScore?: number | null;
  historyPenalty?: number;
}

/** Shared by the server-ranked feed and the client-ranked candidate batch. */
export function scoreRecommendationCandidate(input: CandidateScoreInput): number {
  const qualityFactor = 0.9 + 0.1 * Math.min(1, Math.max(0, input.contentQuality));
  const baseScore =
    (0.65 * input.sourceScore + 0.18 * input.popularity + 0.17 * input.freshness) * qualityFactor +
    POOL_SCORE_WEIGHT * normalizePoolScore(input.poolScore);
  const historyPenalty = Math.min(0.55, Math.max(0, input.historyPenalty ?? 0));
  return baseScore * (1 - historyPenalty);
}

/** Pool IDs join the other independent sources and pass through one dedup step. */
export function collectRecommendationCandidateIds(...sources: ReadonlyArray<Iterable<string>>): string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    for (const id of source) ids.add(id);
  }
  return [...ids];
}

export function buildPoolCandidateSql(filterSql: string): string {
  return `SELECT p.id, ${POOL_SCORE_SQL} AS pool_score
    FROM posts p ${POOL_JOIN_SQL}
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.actor_id IS NOT NULL AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
      ${filterSql} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
    ORDER BY pool_score DESC LIMIT ?`;
}

async function loadPoolCandidates(
  db: D1Database,
  limit: number,
  asOfMs: number,
  filterSql: string,
  filterParams: string[],
): Promise<{ ids: string[]; scoreById: Map<string, number> }> {
  const cutoff = new Date(asOfMs - TRENDING_CANDIDATE_WINDOW_DAYS * 86400_000).toISOString();
  const result = await db
    .prepare(buildPoolCandidateSql(filterSql))
    .bind(...filterParams, cutoff, new Date(asOfMs).toISOString(), limit)
    .all<{ id: string; pool_score: number | null }>();
  const rows = result.results ?? [];
  const scoreById = new Map<string, number>();
  for (const row of rows) {
    const score = Number(row.pool_score);
    scoreById.set(String(row.id), Number.isFinite(score) ? Math.max(0, score) : 0);
  }
  return { ids: rows.map((row) => String(row.id)), scoreById };
}

async function attachRecommendationVectors(
  db: D1Database,
  posts: Array<Record<string, unknown>>,
): Promise<Record<string, EncodedVector>> {
  const ids = posts.map((post) => String(post.id)).filter(Boolean);
  if (ids.length === 0) return {};
  const rows = await db
    .prepare('SELECT post_id, embedding FROM post_embeddings WHERE post_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<{ post_id: string; embedding: string }>();
  const vectors: Record<string, EncodedVector> = {};
  for (const row of rows.results ?? []) {
    try {
      const vector: unknown = JSON.parse(row.embedding);
      if (!Array.isArray(vector) || vector.length !== RECOMMENDATION_VECTOR_DIM) continue;
      const encoded = encodeVector(vector.map(Number));
      if (encoded) vectors[row.post_id] = encoded;
    } catch {
      // A malformed embedding simply removes that candidate from vector ranking.
    }
  }
  return vectors;
}

/**
 * Candidate batch for client-side re-ranking. No preference vector is read or
 * written here: the server returns public embeddings plus its own ranking
 * scores, and the unlocked browser applies cosine similarity locally.
 */
async function loadClientRankedCandidatePage(
  db: D1Database,
  currentUserId: string | null,
  limit: number,
  cursorCreatedAt: string | undefined,
  cursorId: string | undefined,
  asOfMs: number,
  seenIds: Set<string>,
  isArchiveCursor: boolean,
): Promise<{
  posts: Array<Record<string, unknown>>;
  next_cursor: string | null;
  vectors: Record<string, EncodedVector>;
  vector_meta: { dim: number; encoding: 'int8' };
  base_scores: Record<string, number>;
}> {
  const asOfIso = new Date(asOfMs).toISOString();
  const asOfUnixSeconds = Math.floor(asOfMs / 1000);
  const vectorMeta = { dim: RECOMMENDATION_VECTOR_DIM, encoding: 'int8' as const };

  if (isArchiveCursor) {
    const archive = await loadRecommendedArchivePage(db, currentUserId, limit, cursorCreatedAt, cursorId, asOfMs);
    const vectors = await attachRecommendationVectors(db, archive.posts);
    const baseScores: Record<string, number> = {};
    for (const post of archive.posts) baseScores[String(post.id)] = 0.5;
    return { ...archive, vectors, vector_meta: vectorMeta, base_scores: baseScores };
  }

  // Blocked authors stay out. As before, For You excludes the viewer's own
  // ordinary posts; only their own private/direct posts are kept so authors
  // retain access under the visibility predicate below.
  const blockFilter = currentUserId
    ? `AND (p.user_id != ? OR COALESCE(p.visibility, 'public') IN ('private', 'direct'))
       AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)`
    : '';
  const blockParams: string[] = currentUserId ? [currentUserId, currentUserId] : [];
  const { sql: visibilitySql, params: visibilityParams } = visibilityFilter(currentUserId);
  const recentCutoff = new Date(asOfMs - RECENT_CANDIDATE_WINDOW_HOURS * 3600_000).toISOString();
  const trendingCutoff = new Date(asOfMs - TRENDING_CANDIDATE_WINDOW_DAYS * 86400_000).toISOString();
  const engagementFormula = `MAX(COALESCE(p.engagement_hotness, 0), p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + COALESCE(p.bookmark_count, 0) * 2.0 + 1.0) / EXP(1.2 * LN(MAX(0.0, (? - unixepoch(p.created_at)) / 3600.0) + 2.0))`;
  const sourceLimit = Math.min(limit * 2, 200);

  const [recentResult, trendingResult, followingResult, poolCandidates] = await Promise.all([
    db
      .prepare(
        `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
         LEFT JOIN titles t ON t.id = u.equipped_title_id
         WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
           ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
         ORDER BY p.created_at DESC LIMIT ?`,
      )
      .bind(...blockParams, ...visibilityParams, recentCutoff, asOfIso, sourceLimit)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `${RECOMMENDED_SELECT}, (${engagementFormula}) as eng_score FROM posts p LEFT JOIN users u ON p.user_id = u.id
         LEFT JOIN titles t ON t.id = u.equipped_title_id
         WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
           ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
         ORDER BY eng_score DESC, p.created_at DESC LIMIT ?`,
      )
      .bind(asOfUnixSeconds, ...blockParams, ...visibilityParams, trendingCutoff, asOfIso, sourceLimit)
      .all<Record<string, unknown>>(),
    currentUserId
      ? db
          .prepare(
            `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
             LEFT JOIN titles t ON t.id = u.equipped_title_id
             WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
               AND p.created_at >= ? AND p.created_at <= ?
               AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = p.user_id)
               ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER}
             ORDER BY p.created_at DESC LIMIT ?`,
          )
          .bind(trendingCutoff, asOfIso, currentUserId, ...blockParams, ...visibilityParams, sourceLimit)
          .all<Record<string, unknown>>()
      : Promise.resolve(null),
    loadPoolCandidates(db, sourceLimit, asOfMs, `${blockFilter} ${visibilitySql}`, [
      ...blockParams,
      ...visibilityParams,
    ]),
  ]);

  const recentPosts = recentResult.results ?? [];
  const trendingPosts = trendingResult.results ?? [];
  const followingPosts = followingResult?.results ?? [];
  const candidateIds = collectRecommendationCandidateIds(
    followingPosts.map((post) => String(post.id)),
    trendingPosts.map((post) => String(post.id)),
    recentPosts.map((post) => String(post.id)),
    poolCandidates.ids,
  );
  if (candidateIds.length === 0) {
    return loadClientRankedCandidatePage(db, currentUserId, limit, undefined, undefined, asOfMs, seenIds, true);
  }

  const serializedCandidateIds = JSON.stringify(candidateIds);
  const candidateResult = await db
    .prepare(
      `${RECOMMENDED_SELECT}, (${engagementFormula}) as eng_score
       FROM posts p LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.id IN (SELECT value FROM json_each(?))
         AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
         ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER}
         AND p.created_at >= ? AND p.created_at <= ?`,
    )
    .bind(asOfUnixSeconds, serializedCandidateIds, ...blockParams, ...visibilityParams, trendingCutoff, asOfIso)
    .all<Record<string, unknown>>();
  const candidatePosts = candidateResult.results ?? [];

  const freshAtByPost = new Map<string, string>();
  const lastSeenAtByPost = new Map<string, string>();
  if (currentUserId) {
    const [freshRows, impressionRows] = await Promise.all([
      db
        .prepare(
          `SELECT post_id, created_at FROM freshs
           WHERE user_id = ? AND post_id IN (SELECT value FROM json_each(?))
             AND (created_at IS NULL OR created_at <= ?)`,
        )
        .bind(currentUserId, serializedCandidateIds, asOfIso)
        .all<{ post_id: string; created_at: string | null }>(),
      db
        .prepare(
          `SELECT post_id, last_seen_at FROM user_post_impressions
           WHERE user_id = ? AND post_id IN (SELECT value FROM json_each(?))
             AND last_seen_at <= ?`,
        )
        .bind(currentUserId, serializedCandidateIds, asOfIso)
        .all<{ post_id: string; last_seen_at: string }>(),
    ]);
    for (const row of freshRows.results ?? []) {
      if (row.created_at) freshAtByPost.set(row.post_id, row.created_at);
    }
    for (const row of impressionRows.results ?? []) lastSeenAtByPost.set(row.post_id, row.last_seen_at);
  }

  const followingRanks = rankCandidateIds(followingPosts.map((post) => String(post.id)));
  const trendingRanks = rankCandidateIds(trendingPosts.map((post) => String(post.id)));
  const recentRanks = rankCandidateIds(recentPosts.map((post) => String(post.id)));
  const maxEngagement = Math.max(...candidatePosts.map((post) => Math.max(0, Number(post.eng_score) || 0)), 1);
  const maxLogEngagement = Math.log1p(maxEngagement);

  const scored = candidatePosts
    .filter((post) => !seenIds.has(String(post.id)))
    .map((post) => {
      const id = String(post.id);
      const sourceScore =
        0.5 * candidateRankScore(id, followingRanks) +
        0.3 * candidateRankScore(id, trendingRanks) +
        0.2 * candidateRankScore(id, recentRanks);
      const engagement = Math.max(0, Number(post.eng_score) || 0);
      const popularity = maxLogEngagement > 0 ? Math.log1p(engagement) / maxLogEngagement : 0;
      const ageHours = Math.max(0, (asOfMs - new Date(String(post.created_at)).getTime()) / 3600000);
      const freshness = Math.exp(-ageHours / 168);
      const contentQuality = computeQualityScore(
        stripPostColors(String(post.text || '')),
        !!(post.payload_key || post.swf_key || post.gif_key || post.thumbnail_key),
        0,
      );
      const historyPenalty =
        decayingRecommendationPenalty(freshAtByPost.get(id), asOfMs, 0.25, 7) +
        decayingRecommendationPenalty(lastSeenAtByPost.get(id), asOfMs, 0.3, 3);
      const score = scoreRecommendationCandidate({
        sourceScore,
        popularity,
        freshness,
        contentQuality,
        poolScore: poolCandidates.scoreById.get(id),
        historyPenalty,
      });
      delete post.eng_score;
      return { post, score };
    })
    .sort(compareScoredPosts);

  if (scored.length === 0) {
    return loadClientRankedCandidatePage(db, currentUserId, limit, undefined, undefined, asOfMs, seenIds, true);
  }

  const page = scored.slice(0, limit);
  const posts = await enrichRecommendedPosts(
    page.map(({ post }) => post),
    db,
    currentUserId,
  );
  const baseScores: Record<string, number> = {};
  for (const entry of page) baseScores[String(entry.post.id)] = entry.score;
  for (const post of posts) seenIds.add(String(post.id));

  const vectors = await attachRecommendationVectors(db, posts);
  const lastPost = posts.at(-1);
  const lastScore = lastPost ? baseScores[String(lastPost.id)] : null;
  const nextCursor =
    !lastPost || lastScore === null
      ? null
      : seenIds.size >= 700
        ? `archive,,,${asOfMs}`
        : `${lastScore},${lastPost.created_at},${lastPost.id},${asOfMs},${[...seenIds].join(':')}`;

  return { posts, next_cursor: nextCursor, vectors, vector_meta: vectorMeta, base_scores: baseScores };
}

// GET /api/posts/recommended - multi-source feed inspired by X's Home Mixer.
recommendations.get('/posts/recommended', async (c) => {
  try {
    const clientRank = c.req.query('client_rank') === '1' || c.req.query('include_vectors') === '1';
    // `external=hide` is the server-side half of the "don't show" choice. The
    // client sends it for its own preference so hidden posts never reach the
    // browser, even on the unranked fallback path.
    const hideRemote = c.req.query('external') === 'hide';
    const limit = clientRank
      ? clampLimit(c.req.query('limit'), 80, CLIENT_RANK_VECTOR_BATCH_MAX)
      : clampLimit(c.req.query('limit'), 20, 50);
    const cursor = c.req.query('cursor');
    const cursorParts = cursor ? cursor.split(',') : [];
    const isArchiveCursor = cursorParts[0] === 'archive';
    const [cursorScore, cursorCreatedAt, cursorId] = cursorParts;
    const numericCursor = cursorScore ? Number.parseFloat(cursorScore) : null;
    const cursorAsOf = Number(cursorParts[3]);
    const now = Date.now();
    if (cursorParts[3] && (!Number.isSafeInteger(cursorAsOf) || cursorAsOf <= 0 || cursorAsOf > now)) {
      return c.json({ error: 'Invalid recommendation cursor' }, 400);
    }
    const asOfMs = cursorParts[3] ? cursorAsOf : now;
    // Carry the IDs already delivered in this bounded candidate pool. Scores,
    // follows and impression timestamps can still change after asOf; a time
    // bound alone cannot make a mutable ranking safe for score pagination.
    const seenIds = new Set(cursorParts[4]?.split(':').filter(Boolean) ?? []);
    if (seenIds.size > 700 || [...seenIds].some((id) => !/^[A-Za-z0-9_-]{1,36}$/.test(id))) {
      return c.json({ error: 'Invalid recommendation cursor' }, 400);
    }
    const asOfUnixSeconds = Math.floor(asOfMs / 1000);
    // Exclude posts and embeddings created after the feed began. The delivered
    // ID set below also protects against changes to existing candidate ranks.
    const asOfIso = new Date(asOfMs).toISOString();
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const db = c.env.DB;
    const currentUserId = c.get('user')?.id || null;
    if (clientRank) {
      const page = await loadClientRankedCandidatePage(
        db,
        currentUserId,
        limit,
        cursorCreatedAt,
        cursorId,
        asOfMs,
        seenIds,
        isArchiveCursor,
      );
      return c.json({ ...page, posts: presentForYou(page.posts, limit, hideRemote, false) });
    }

    if (isArchiveCursor) {
      const page = await loadRecommendedArchivePage(db, currentUserId, limit, cursorCreatedAt, cursorId, asOfMs);
      return c.json({ ...page, posts: presentForYou(page.posts, limit, hideRemote, true) });
    }

    const blockFilter = currentUserId
      ? `AND (p.user_id != ? OR COALESCE(p.visibility, 'public') IN ('private', 'direct'))
       AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)`
      : '';
    const blockParams: string[] = currentUserId ? [currentUserId, currentUserId] : [];
    const { sql: visibilitySql, params: visibilityParams } = visibilityFilter(currentUserId);
    const recentCutoff = new Date(asOfMs - RECENT_CANDIDATE_WINDOW_HOURS * 3600_000).toISOString();
    const trendingCutoff = new Date(asOfMs - TRENDING_CANDIDATE_WINDOW_DAYS * 86400_000).toISOString();
    const engagementFormula = `MAX(COALESCE(p.engagement_hotness, 0), p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0 + COALESCE(p.bookmark_count, 0) * 2.0 + 1.0) / EXP(1.2 * LN(MAX(0.0, (? - unixepoch(p.created_at)) / 3600.0) + 2.0))`;

    const [recentResult, trendingResult, followingResult, poolCandidates] = await Promise.all([
      db
        .prepare(
          `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
           WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
             ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
           ORDER BY p.created_at DESC LIMIT ?`,
        )
        .bind(...blockParams, ...visibilityParams, recentCutoff, asOfIso, limit * 4)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `${RECOMMENDED_SELECT}, (${engagementFormula}) as eng_score FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
           WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
             ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER} AND p.created_at >= ? AND p.created_at <= ?
           ORDER BY eng_score DESC, p.created_at DESC LIMIT ?`,
        )
        .bind(asOfUnixSeconds, ...blockParams, ...visibilityParams, trendingCutoff, asOfIso, limit * 4)
        .all<Record<string, unknown>>(),
      currentUserId
        ? db
            .prepare(
              `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
               WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
                 AND p.created_at >= ? AND p.created_at <= ?
                 AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = p.user_id)
                 ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER}
               ORDER BY p.created_at DESC LIMIT ?`,
            )
            .bind(trendingCutoff, asOfIso, currentUserId, ...blockParams, ...visibilityParams, limit * 4)
            .all<Record<string, unknown>>()
        : Promise.resolve(null),
      loadPoolCandidates(db, limit * 4, asOfMs, `${blockFilter} ${visibilitySql}`, [
        ...blockParams,
        ...visibilityParams,
      ]),
    ]);

    const recentPosts = recentResult.results || [];
    const trendingPosts = trendingResult.results || [];
    const followingPosts = followingResult?.results || [];
    const candidateIds = collectRecommendationCandidateIds(
      followingPosts.map((post) => String(post.id)),
      trendingPosts.map((post) => String(post.id)),
      recentPosts.map((post) => String(post.id)),
      poolCandidates.ids,
    );
    if (candidateIds.length === 0) {
      const page = await loadRecommendedArchivePage(db, currentUserId, limit, undefined, undefined, asOfMs);
      return c.json({ ...page, posts: presentForYou(page.posts, limit, hideRemote, true) });
    }

    // Candidate sources can contribute hundreds of IDs. Bind the set as JSON
    // so D1's 100-parameter ceiling does not turn a populated feed into a 500.
    const serializedCandidateIds = JSON.stringify(candidateIds);
    const candidateQuery = `${RECOMMENDED_SELECT}, (${engagementFormula}) as eng_score
      FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
      WHERE p.id IN (SELECT value FROM json_each(?))
        AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER} ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER}
        AND p.created_at >= ? AND p.created_at <= ?`;
    const candidateResult = await db
      .prepare(candidateQuery)
      .bind(asOfUnixSeconds, serializedCandidateIds, ...blockParams, ...visibilityParams, trendingCutoff, asOfIso)
      .all<Record<string, unknown>>();
    const candidatePosts = candidateResult.results || [];

    const followingRanks = rankCandidateIds(followingPosts.map((post) => String(post.id)));
    const trendingRanks = rankCandidateIds(trendingPosts.map((post) => String(post.id)));
    const recentRanks = rankCandidateIds(recentPosts.map((post) => String(post.id)));

    const freshAtByPost = new Map<string, string>();
    const lastSeenAtByPost = new Map<string, string>();
    if (currentUserId) {
      const [freshRows, impressionRows] = await Promise.all([
        db
          .prepare(
            `SELECT post_id, created_at FROM freshs
             WHERE user_id = ? AND post_id IN (SELECT value FROM json_each(?))
               AND (created_at IS NULL OR created_at <= ?)`,
          )
          .bind(currentUserId, serializedCandidateIds, asOfIso)
          .all<{ post_id: string; created_at: string | null }>(),
        db
          .prepare(
            `SELECT post_id, last_seen_at FROM user_post_impressions
             WHERE user_id = ? AND post_id IN (SELECT value FROM json_each(?))
               AND last_seen_at <= ?`,
          )
          .bind(currentUserId, serializedCandidateIds, asOfIso)
          .all<{ post_id: string; last_seen_at: string }>(),
      ]);
      for (const row of freshRows.results || []) {
        if (row.created_at) freshAtByPost.set(row.post_id, row.created_at);
      }
      for (const row of impressionRows.results || []) lastSeenAtByPost.set(row.post_id, row.last_seen_at);
    }

    const engagementValues = candidatePosts.map((post) => Math.max(0, Number(post.eng_score) || 0));
    const maxEngagement = Math.max(...engagementValues, 1);
    const maxLogEngagement = Math.log1p(maxEngagement);
    const scoredPosts = candidatePosts.map((post) => {
      const id = String(post.id);
      const sourceScore =
        0.5 * candidateRankScore(id, followingRanks) +
        0.3 * candidateRankScore(id, trendingRanks) +
        0.2 * candidateRankScore(id, recentRanks);
      const engagement = Math.max(0, Number(post.eng_score) || 0);
      const popularity = maxLogEngagement > 0 ? Math.log1p(engagement) / maxLogEngagement : 0;
      const ageHours = Math.max(0, (asOfMs - new Date(String(post.created_at)).getTime()) / 3600000);
      const freshness = Math.exp(-ageHours / 168);
      const contentQuality = computeQualityScore(
        stripPostColors(String(post.text || '')),
        !!(post.payload_key || post.swf_key || post.gif_key || post.thumbnail_key),
        0,
      );
      const historyPenalty =
        decayingRecommendationPenalty(freshAtByPost.get(id), asOfMs, 0.25, 7) +
        decayingRecommendationPenalty(lastSeenAtByPost.get(id), asOfMs, 0.3, 3);
      const score = scoreRecommendationCandidate({
        sourceScore,
        popularity,
        freshness,
        contentQuality,
        poolScore: poolCandidates.scoreById.get(id),
        historyPenalty,
      });
      delete post.eng_score;
      return { post, score };
    });

    let filteredPosts = scoredPosts.filter(({ post }) => !seenIds.has(String(post.id)));
    const validCursor = numericCursor !== null && Number.isFinite(numericCursor) && cursorCreatedAt && cursorId;
    if (validCursor && cursorParts.length < 5) {
      filteredPosts = scoredPosts.filter(({ post, score }) => {
        const createdAt = String(post.created_at || '');
        const id = String(post.id || '');
        return (
          score < numericCursor! ||
          (score === numericCursor && createdAt < cursorCreatedAt!) ||
          (score === numericCursor && createdAt === cursorCreatedAt && id < cursorId!)
        );
      });
    }

    if (filteredPosts.length === 0) {
      const page = await loadRecommendedArchivePage(db, currentUserId, limit, undefined, undefined, asOfMs);
      return c.json({ ...page, posts: presentForYou(page.posts, limit, hideRemote, true) });
    }

    filteredPosts.sort(compareScoredPosts);
    const pagePosts = diversifyPosts(filteredPosts, limit, 2).map(({ post, score }) => {
      post.score = score;
      return post;
    });
    const enrichedPosts = await enrichRecommendedPosts(pagePosts, db, currentUserId);
    // Pagination follows the ranked (unmixed) page so the score cursor stays
    // monotonic; only the response is interleaved for display.
    const lastPost = enrichedPosts.at(-1) as Record<string, unknown> | undefined;
    for (const post of enrichedPosts) seenIds.add(String(post.id));
    // At most 800 candidate IDs come from the four time-bounded sources (4*200).
    // Bound cursor growth well below Cloudflare's URL ceiling before moving
    // into the chronological archive, whose cursor does not need an ID set.
    const nextCursor = !lastPost
      ? null
      : seenIds.size >= 700
        ? `archive,,,${asOfMs}`
        : `${lastPost.score},${lastPost.created_at},${lastPost.id},${asOfMs},${[...seenIds].join(':')}`;

    return c.json({ posts: presentForYou(enrichedPosts, limit, hideRemote, true), next_cursor: nextCursor });
  } catch (error: unknown) {
    console.error('Recommended posts error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

async function loadRecommendedArchivePage(
  db: D1Database,
  currentUserId: string | null,
  limit: number,
  cursorCreatedAt?: string,
  cursorId?: string,
  asOfMs = Date.now(),
): Promise<{ posts: Record<string, unknown>[]; next_cursor: string | null }> {
  const archiveCutoff = new Date(asOfMs - TRENDING_CANDIDATE_WINDOW_DAYS * 86400_000).toISOString();
  const asOfIso = new Date(asOfMs).toISOString();
  const hasCursor = Boolean(cursorCreatedAt && cursorId);
  const cursorFilter = hasCursor ? '(p.created_at < ? OR (p.created_at = ? AND p.id < ?))' : 'p.created_at < ?';
  const params: Array<string | number> = hasCursor ? [cursorCreatedAt!, cursorCreatedAt!, cursorId!] : [archiveCutoff];
  const blockFilter = currentUserId
    ? `AND (p.user_id != ? OR COALESCE(p.visibility, 'public') IN ('private', 'direct'))
       AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)`
    : '';
  const { sql: visibilitySql, params: visibilityParams } = visibilityFilter(currentUserId);
  if (currentUserId) params.push(currentUserId, currentUserId);
  params.push(...visibilityParams, asOfIso, limit + 1);

  const result = await db
    .prepare(
      `${RECOMMENDED_SELECT} FROM posts p LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN titles t ON t.id = u.equipped_title_id
       WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL ${EXACT_DUPLICATE_FILTER}
         AND ${cursorFilter} ${blockFilter} ${visibilitySql} ${RECOMMENDATION_TRUST_FILTER}
         AND p.created_at <= ?
       ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const posts = await enrichRecommendedPosts(rows.slice(0, limit), db, currentUserId);
  const lastPost = posts.at(-1);
  const nextCursor = hasMore && lastPost ? `archive,${lastPost.created_at},${lastPost.id},${asOfMs}` : null;

  return { posts, next_cursor: nextCursor };
}

async function enrichRecommendedPosts(
  posts: Record<string, unknown>[],
  db: D1Database,
  currentUserId: string | null | undefined,
): Promise<Record<string, unknown>[]> {
  await enrichFeedPosts(posts as PostRow[], db, currentUserId);
  return posts;
}

// GET /api/posts/:id/similar - get similar posts based on vector embedding
