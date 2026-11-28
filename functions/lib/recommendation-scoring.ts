// Pure For You scoring helpers, shared by the server-ranked feed and the
// client-ranked candidate batch. Kept out of the route module so a large HTTP
// handler file does not keep growing.

/** Federated popularity is a bounded nudge (log scale). */
export const POOL_SCORE_WEIGHT = 0.08;
/** Small affinity nudge so the feed leans toward the reader's language. */
export const LANGUAGE_AFFINITY_WEIGHT = 0.15;

/**
 * Inspired by X's `RankingScorer`: named weights are applied to *predicted*
 * action values, not to raw engagement counts. Flaxia has no per-viewer Phoenix
 * predictions yet, so these are small boosts on 0..1 signals and deliberately
 * much lower than X's weights (whose base score is on a different scale).
 *
 * The sum of all weights bounds the whole action-signal term, and none of them
 * reuses the `sourceScore`/`popularity` inputs below — those remain the
 * independent source-rank and engagement terms.
 */
export const ACTION_SIGNAL_WEIGHTS = {
  fresh: 0.02,
  bookmark: 0.03,
  reply: 0.03,
  share: 0.03,
  view: 0.01,
  dwell: 0.02,
} as const;

export type ActionSignalName = keyof typeof ACTION_SIGNAL_WEIGHTS;
export type ActionSignals = Partial<Record<ActionSignalName, number | null | undefined>>;

/** Missing, non-finite and out-of-range predictions contribute nothing. */
export function normalizeActionSignal(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Weighted sum of bounded action predictions; never recurses into popularity. */
export function actionSignalScore(signals: ActionSignals = {}): number {
  let total = 0;
  for (const name of Object.keys(ACTION_SIGNAL_WEIGHTS) as ActionSignalName[]) {
    total += ACTION_SIGNAL_WEIGHTS[name] * normalizeActionSignal(signals[name]);
  }
  return total;
}

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
  /** Per-action 0..1 predictions (or bounded propensity proxies). */
  actionSignals?: ActionSignals;
}

export function scoreRecommendationCandidate(input: CandidateScoreInput): number {
  const qualityFactor = 0.9 + 0.1 * Math.min(1, Math.max(0, input.contentQuality));
  const affinity = Math.min(1, Math.max(0, input.languageAffinity ?? 0));
  const baseScore =
    (0.65 * input.sourceScore + 0.18 * input.popularity + 0.17 * input.freshness) * qualityFactor +
    POOL_SCORE_WEIGHT * normalizePoolScore(input.poolScore) +
    LANGUAGE_AFFINITY_WEIGHT * affinity +
    actionSignalScore(input.actionSignals);
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
