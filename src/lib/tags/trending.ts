// Shared trending-tags request. Home renders both LeftNav and RightPanel, so
// each page used to fetch `/api/tags/trending` independently. Cache the
// in-flight request (and briefly the result) so a page mount costs one call.

export interface TrendingTag {
  tag: string;
  count: number;
  percentage?: number;
}

const CACHE_TTL_MS = 60_000;

let cached: { at: number; tags: TrendingTag[] } | null = null;
let pending: Promise<TrendingTag[]> | null = null;

export function loadTrendingTags(): Promise<TrendingTag[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.tags);
  if (pending) return pending;

  pending = fetch('/api/tags/trending')
    .then(async (response) => {
      if (!response.ok) throw new Error('Failed to load trending tags');
      const data = (await response.json()) as { tags?: TrendingTag[] };
      return data.tags ?? [];
    })
    .then((tags) => {
      cached = { at: Date.now(), tags };
      return tags;
    })
    .catch(() => [])
    .finally(() => {
      pending = null;
    });

  return pending;
}
