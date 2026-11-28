// Pure post-scoring adjustments inspired by X's `RankingScorer`:
// repeated-author decay and a bounded new-author boost. Visibility filtering
// stays separate (see `functions/lib/post-visibility.ts`); no out-of-network
// discount is applied because Flaxia's For You pool is local-only.

/** Each repeated post from the same author is multiplied down toward the floor. */
export const AUTHOR_DIVERSITY_DECAY = 0.7;
export const AUTHOR_DIVERSITY_FLOOR = 0.5;

/** An author is "new" below both of these limits (X uses an impressions threshold). */
export const NEW_AUTHOR_IMPRESSION_THRESHOLD = 50;
export const NEW_AUTHOR_POST_COUNT_THRESHOLD = 3;
/** Lift a new author no higher than this fraction of the page. */
export const NEW_AUTHOR_BOOST_POSITION_RATIO = 0.75;

export interface ScoredCandidate {
  score: number;
}

export interface AuthorStats {
  postCount: number;
  impressions: number;
}

export function authorDiversityMultiplier(
  repeats: number,
  decay = AUTHOR_DIVERSITY_DECAY,
  floor = AUTHOR_DIVERSITY_FLOOR,
): number {
  const safeDecay = Number.isFinite(decay) ? Math.min(1, Math.max(0, decay)) : 1;
  const safeFloor = Number.isFinite(floor) ? Math.min(1, Math.max(0, floor)) : 0;
  const exponent = Number.isFinite(repeats) ? Math.max(0, Math.floor(repeats)) : 0;
  return (1 - safeFloor) * safeDecay ** exponent + safeFloor;
}

/**
 * Apply the decay to an already author-capped page, then re-sort so the score
 * used for the cursor matches the delivered order. Inputs are never mutated.
 */
export function applyAuthorDiversityDecay<T extends ScoredCandidate>(
  items: readonly T[],
  authorOf: (item: T) => string,
): T[] {
  const seen = new Map<string, number>();
  return items
    .map((item, index) => {
      const author = authorOf(item);
      const repeats = seen.get(author) ?? 0;
      seen.set(author, repeats + 1);
      return { index, item: { ...item, score: item.score * authorDiversityMultiplier(repeats) } };
    })
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .map(({ item }) => item);
}

export function isNewAuthor(stats: AuthorStats | undefined): boolean {
  if (!stats) return false;
  return stats.impressions < NEW_AUTHOR_IMPRESSION_THRESHOLD && stats.postCount <= NEW_AUTHOR_POST_COUNT_THRESHOLD;
}

/**
 * Lift low-impression authors to at least the score at `targetRank` in the
 * sorted pool. This can never raise them above the current leaders, and leaves
 * established authors untouched.
 */
export function applyNewAuthorBoost<T extends ScoredCandidate>(
  items: readonly T[],
  authorOf: (item: T) => string,
  statsByAuthor: ReadonlyMap<string, AuthorStats>,
  targetRank = Math.floor(items.length * NEW_AUTHOR_BOOST_POSITION_RATIO),
): T[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor(targetRank)));
  const targetScore = sorted[rank]!.score;
  return items.map((item) =>
    isNewAuthor(statsByAuthor.get(authorOf(item))) ? { ...item, score: Math.max(item.score, targetScore) } : item,
  );
}
