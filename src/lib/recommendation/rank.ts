// Client-side candidate ranking. The server supplies only non-personal public
// features plus candidate embeddings; the decrypted preference vector never
// leaves this module's caller.

import { cosineSimilarity, normalizedCosine } from './vector.ts';

export interface RankOptions<T> {
  items: readonly T[];
  profile: readonly number[] | null;
  getVector: (item: T) => readonly number[] | null;
  getBaseScore: (item: T) => number;
  limit: number;
  getAuthor?: (item: T) => string;
  /** Weight of cosine relevance against the server's non-personal base score. */
  personalWeight?: number;
  /** Higher values favor relevance; lower values favor MMR diversity. */
  mmrLambda?: number;
  maxPerAuthor?: number;
}

interface Prepared<T> {
  item: T;
  index: number;
  vector: readonly number[] | null;
  base: number;
  relevance: number;
  combined: number;
  author: string;
}

/**
 * Blend relevance with the non-personal base score, then apply maximal
 * marginal relevance plus a per-author cap. Without a profile the server's
 * order is preserved so a locked/absent vault never degrades the feed.
 */
export function rankCandidates<T>(options: RankOptions<T>): T[] {
  const {
    items,
    profile,
    getVector,
    getBaseScore,
    limit,
    getAuthor,
    personalWeight = 0.45,
    mmrLambda = 0.75,
    maxPerAuthor = 2,
  } = options;

  if (limit <= 0 || items.length === 0) return [];

  const prepared: Prepared<T>[] = items.map((item, index) => {
    const vector = getVector(item);
    const baseRaw = Number(getBaseScore(item));
    const base = Number.isFinite(baseRaw) ? Math.max(0, Math.min(1, baseRaw)) : 0;
    const relevance = profile && vector ? normalizedCosine(profile, vector) : 0;
    return {
      item,
      index,
      vector,
      base,
      relevance,
      combined: profile && vector ? (1 - personalWeight) * base + personalWeight * relevance : base,
      author: getAuthor ? getAuthor(item) : '',
    };
  });

  if (!profile) {
    return [...prepared]
      .sort((a, b) => b.combined - a.combined || a.index - b.index)
      .filter(withAuthorCap(maxPerAuthor))
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  const remaining = [...prepared].sort((a, b) => b.combined - a.combined || a.index - b.index);
  const selected: Prepared<T>[] = [];
  const authorCounts = new Map<string, number>();

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (candidate.author && (authorCounts.get(candidate.author) || 0) >= maxPerAuthor) continue;
      let maxSimilarity = 0;
      if (candidate.vector) {
        for (const picked of selected) {
          if (!picked.vector) continue;
          const similarity = Math.max(0, cosineSimilarity(candidate.vector, picked.vector));
          if (similarity > maxSimilarity) maxSimilarity = similarity;
        }
      }
      const score = mmrLambda * candidate.combined - (1 - mmrLambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    if (chosen.author) authorCounts.set(chosen.author, (authorCounts.get(chosen.author) || 0) + 1);
  }

  return selected.map((entry) => entry.item);
}

function withAuthorCap<T>(maxPerAuthor: number) {
  const counts = new Map<string, number>();
  return (entry: Prepared<T>): boolean => {
    const author = entry.author;
    if (!author) return true;
    const count = counts.get(author) || 0;
    if (count >= maxPerAuthor) return false;
    counts.set(author, count + 1);
    return true;
  };
}
