import type { AdminAnalytics, AnalyticsMetrics } from '../../src/types/admin-analytics';

export function parseAnalyticsDays(value: string | undefined): number | null {
  if (value === undefined) return 30;
  return /^(7|30|90)$/.test(value) ? Number(value) : null;
}

// Only existing local accounts contribute. No new client tracking is needed.
const GAME_RANKING_BASE_SQL = `
  SELECT p.id AS post_id,
    COALESCE(
      NULLIF(p.game_description, ''),
      NULLIF(TRIM(p.text), ''),
      'Game by @' || owner.username
    ) AS title,
    owner.username,
    COUNT(*) AS play_count,
    COALESCE(SUM(g.dwell_ms), 0) AS dwell_ms
  FROM user_game_plays g
    INNER JOIN users player ON player.id = g.user_id
    INNER JOIN posts p ON p.id = g.post_id
    INNER JOIN users owner ON owner.id = p.user_id
  WHERE g.created_at >= ? AND g.created_at < ?
    AND (p.payload_key IS NOT NULL OR p.swf_key IS NOT NULL)
    AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL
  GROUP BY p.id, p.game_description, p.text, owner.username
`;

const TOP_GAMES_SQL = `
  ${GAME_RANKING_BASE_SQL}
  ORDER BY play_count DESC, dwell_ms DESC, title COLLATE NOCASE ASC
  LIMIT 10
`;

const TOP_DWELL_GAMES_SQL = `
  ${GAME_RANKING_BASE_SQL}
  ORDER BY dwell_ms DESC, play_count DESC, title COLLATE NOCASE ASC
  LIMIT 10
`;

const ANALYTICS_SQL = `
  WITH events AS (
    SELECT created_at, id AS user_id, 'signup' AS kind, 0 AS dwell_ms
      FROM users WHERE created_at >= ? AND created_at < ?
    UNION ALL
    SELECT p.created_at, p.user_id, 'post', 0 FROM posts p
      INNER JOIN users u ON u.id = p.user_id
      WHERE p.created_at >= ? AND p.created_at < ?
    UNION ALL
    SELECT f.created_at, f.user_id, 'fresh', 0 FROM freshs f
      INNER JOIN users u ON u.id = f.user_id
      WHERE f.created_at >= ? AND f.created_at < ?
    UNION ALL
    SELECT g.created_at, g.user_id, 'play', g.dwell_ms FROM user_game_plays g
      INNER JOIN users u ON u.id = g.user_id
      WHERE g.created_at >= ? AND g.created_at < ?
  )
  SELECT substr(created_at, 1, 10) AS day,
    SUM(kind = 'signup') AS new_users, SUM(kind = 'post') AS posts,
    SUM(kind = 'fresh') AS freshs, SUM(kind = 'play') AS game_plays,
    COUNT(DISTINCT CASE WHEN kind != 'signup' THEN user_id END) AS active_users,
    SUM(dwell_ms) AS dwell_ms
  FROM events GROUP BY day
  UNION ALL
  SELECT 'summary',
    COALESCE(SUM(kind = 'signup'), 0), COALESCE(SUM(kind = 'post'), 0),
    COALESCE(SUM(kind = 'fresh'), 0), COALESCE(SUM(kind = 'play'), 0),
    COUNT(DISTINCT CASE WHEN kind != 'signup' THEN user_id END),
    COALESCE(SUM(dwell_ms), 0)
  FROM events
`;

export async function getAdminAnalytics(db: D1Database, days: number, now = new Date()): Promise<AdminAnalytics> {
  const startDate = new Date(now);
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  const start = startDate.toISOString();
  const end = now.toISOString();
  const [[metrics, totals], [topGames, topDwellGames]] = await Promise.all([
    db.batch<AnalyticsMetrics & { day: string; users: number }>([
      db.prepare(ANALYTICS_SQL).bind(start, end, start, end, start, end, start, end),
      db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM posts p INNER JOIN users u ON u.id = p.user_id) AS posts`),
    ]),
    db.batch<AdminAnalytics['top_games'][number]>([
      db.prepare(TOP_GAMES_SQL).bind(start, end),
      db.prepare(TOP_DWELL_GAMES_SQL).bind(start, end),
    ]),
  ]);
  const empty: AnalyticsMetrics = { new_users: 0, posts: 0, freshs: 0, game_plays: 0, active_users: 0, dwell_ms: 0 };
  const rows = new Map(metrics.results.map((row) => [row.day, row]));
  const summary = rows.get('summary') || empty;
  const daily: AdminAnalytics['daily'] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setUTCDate(date.getUTCDate() + i);
    const day = date.toISOString().slice(0, 10);
    daily.push({ ...empty, ...rows.get(day), day });
  }
  return {
    days,
    start,
    end,
    timezone: 'UTC',
    totals: { users: totals.results[0]?.users ?? 0, posts: totals.results[0]?.posts ?? 0 },
    top_games: topGames.results || [],
    top_dwell_games: topDwellGames.results || [],
    summary: {
      new_users: summary.new_users,
      posts: summary.posts,
      freshs: summary.freshs,
      game_plays: summary.game_plays,
      active_users: summary.active_users,
      dwell_ms: summary.dwell_ms,
    },
    daily,
  };
}
