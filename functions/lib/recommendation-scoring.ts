// Pure For You scoring helpers, shared by the server-ranked feed and the
// client-ranked candidate batch. Kept out of the route module so a large HTTP
// handler file does not keep growing.

/** Federated popularity is a bounded nudge (log scale). */
export const POOL_SCORE_WEIGHT = 0.08;
/** Small affinity nudge so the feed leans toward the reader's language. */
export const LANGUAGE_AFFINITY_WEIGHT = 0.15;

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
  /** 1 when the candidate is written in the reader's language, else 0. */
  languageAffinity?: number;
}

export function scoreRecommendationCandidate(input: CandidateScoreInput): number {
  const qualityFactor = 0.9 + 0.1 * Math.min(1, Math.max(0, input.contentQuality));
  const affinity = Math.min(1, Math.max(0, input.languageAffinity ?? 0));
  const baseScore =
    (0.65 * input.sourceScore + 0.18 * input.popularity + 0.17 * input.freshness) * qualityFactor +
    POOL_SCORE_WEIGHT * normalizePoolScore(input.poolScore) +
    LANGUAGE_AFFINITY_WEIGHT * affinity;
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
