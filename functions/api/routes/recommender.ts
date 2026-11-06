import type { D1Database } from '@cloudflare/workers-types';

const DWELL_STATS_CACHE_KEY = 'arcade:dwell:stats:v2';
const DWELL_STATS_TTL_S = 60;

// Aggregate dwell stats are shared across all users, so cache them globally
// (60s) instead of re-scanning the whole user_game_plays table on every
// recommended-games request. The scan is also bounded to a recent window.
async function loadDwellStats(
  db: D1Database,
  cache: KVNamespace | undefined,
): Promise<{ dwellStats: Map<string, { avgDwell: number; playCount: number }>; maxAvgDwell: number }> {
  if (cache) {
    try {
      const raw = await cache.get(DWELL_STATS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { avgDwell: number; playCount: number }>;
        const dwellStats = new Map(Object.entries(parsed));
        let maxAvgDwell = 1;
        for (const d of dwellStats.values()) {
          if (d.avgDwell > maxAvgDwell) maxAvgDwell = d.avgDwell;
        }
        return { dwellStats, maxAvgDwell };
      }
    } catch {
      /* fall through to recompute */
    }
  }

  const dwellStats = new Map<string, { avgDwell: number; playCount: number }>();
  const dwellResult = await db
    .prepare(
      `SELECT post_id, AVG(dwell_ms) as avg_dwell, COUNT(*) as play_count
       FROM user_game_plays
       WHERE dwell_ms > 2000 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
       GROUP BY post_id`,
    )
    .all<{ post_id: string; avg_dwell: number; play_count: number }>();
  let maxAvgDwell = 1;
  for (const row of dwellResult.results || []) {
    const avgDwell = Number(row.avg_dwell) || 0;
    dwellStats.set(row.post_id, { avgDwell, playCount: row.play_count });
    if (avgDwell > maxAvgDwell) maxAvgDwell = avgDwell;
  }
  if (cache) {
    try {
      await cache.put(DWELL_STATS_CACHE_KEY, JSON.stringify(Object.fromEntries(dwellStats)), {
        expirationTtl: DWELL_STATS_TTL_S,
      });
    } catch {
      /* ignore cache write failure */
    }
  }
  return { dwellStats, maxAvgDwell };
}

export { loadDwellStats };
