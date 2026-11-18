/**
 * Keyed-list helpers for paginated API feeds.
 *
 * Ranking and cursor pagination can return the same row twice (the recommendation
 * feed already documents this), and the keyed renderer treats duplicate keys as a
 * programming error. Deduplicate before handing a list to `each()` instead of
 * letting a legitimate server response throw mid-reconcile.
 */

/** Keep the first occurrence of each key, preserving order. */
export function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];

  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }

  return result;
}

/** Append `incoming` to `existing`, skipping keys that are already present. */
export function appendUniqueBy<T, K>(existing: readonly T[], incoming: readonly T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];

  for (const item of existing) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }

  for (const item of incoming) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }

  return result;
}
