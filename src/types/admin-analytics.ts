export interface AnalyticsMetrics {
  new_users: number;
  posts: number;
  freshs: number;
  game_plays: number;
  active_users: number;
  dwell_ms: number;
}

export interface AdminAnalytics {
  days: number;
  start: string;
  end: string;
  timezone: 'UTC';
  totals: { users: number; posts: number };
  summary: AnalyticsMetrics;
  daily: Array<AnalyticsMetrics & { day: string }>;
}
