export interface AnalyticsMetrics {
  new_users: number;
  posts: number;
  freshs: number;
  game_plays: number;
  active_users: number;
  dwell_ms: number;
}

export interface GameRanking {
  post_id: string;
  title: string;
  username: string;
  play_count: number;
  dwell_ms: number;
}

export interface AdminAnalytics {
  days: number;
  start: string;
  end: string;
  timezone: 'UTC';
  totals: { users: number; posts: number };
  top_games: GameRanking[];
  top_dwell_games: GameRanking[];
  summary: AnalyticsMetrics;
  daily: Array<AnalyticsMetrics & { day: string }>;
}
