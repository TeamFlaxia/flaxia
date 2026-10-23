import type { D1Database } from '@cloudflare/workers-types';

// Deterministic, versioned vocabulary. Read-time tagging covers old posts,
// edits and every publishing path without changing user-authored hashtags.
// Keep broad/ambiguous terms (e.g. "art", "go", "play") out of these rules.
const TOPICS = [
  { tag: 'ゲーム', pattern: /ゲーム|ゲーミング|\b(games?|gaming|unity|godot|unreal|platformers?)\b/i },
  {
    tag: 'プログラミング',
    pattern: /プログラミング|コーディング|ソフトウェア|\b(programming|coding|typescript|javascript|python|rust)\b/i,
  },
  { tag: 'ai', pattern: /人工知能|生成ai|機械学習|\b(ai|llms?|chatgpt|claude|machine learning)\b/i },
  { tag: '音楽', pattern: /音楽|作曲|歌って|ボカロ|\b(music|songs?|guitar|piano|vocaloid)\b/i },
  { tag: 'イラスト', pattern: /イラスト|お絵描き|絵描き|水彩|\b(illustration|drawing|watercolou?r|painting)\b/i },
  { tag: 'アニメ', pattern: /アニメ|漫画|マンガ|\b(anime|manga)\b/i },
  { tag: '写真', pattern: /写真|撮影|カメラ|\b(photography|photos?|camera)\b/i },
  { tag: '料理', pattern: /料理|レシピ|自炊|パン作り|\b(cooking|recipes?|baking|sourdough)\b/i },
  { tag: '旅行', pattern: /旅行|観光|旅先|\b(travel|tourism|sightseeing)\b/i },
  { tag: 'スポーツ', pattern: /スポーツ|サッカー|野球|バスケ|\b(sports?|soccer|football|baseball|basketball)\b/i },
  { tag: '科学', pattern: /科学|物理|天文学|宇宙|\b(science|physics|astronomy|orbital mechanics)\b/i },
  { tag: '読書', pattern: /読書|小説|書評|\b(books?|novels?|reading)\b/i },
] as const;

export interface TopicPost {
  id: string;
  text: string;
  hashtags: string | null;
}

export function normalizeTag(tag: string): string {
  return tag.normalize('NFKC').replace(/^#+/, '').trim().toLowerCase();
}

export function isAutomaticTopic(tag: string): boolean {
  return TOPICS.some((topic) => topic.tag === normalizeTag(tag));
}

export function extractTopicTags(text: string, hashtags: string | null = '[]'): string[] {
  const tags = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(hashtags || '[]');
    if (Array.isArray(parsed)) {
      for (const tag of parsed) {
        if (typeof tag !== 'string') continue;
        const normalized = normalizeTag(tag);
        if (/^[\p{L}\p{N}_ー]{1,40}$/u.test(normalized)) tags.add(normalized);
      }
    }
  } catch {
    // A malformed historical hashtag field must not break a feed.
  }
  const content = text.normalize('NFKC').replace(/https?:\/\/\S+|@[a-zA-Z0-9_]+/gi, ' ');
  for (const topic of TOPICS) {
    if (topic.pattern.test(content) || [...tags].some((tag) => topic.pattern.test(tag))) tags.add(topic.tag);
  }
  return [...tags];
}

export function aggregateTopicTags(posts: TopicPost[], limit = 5) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of extractTopicTags(post.text, post.hashtags)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts]
    .sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count, percentage: Math.round((count * 1000) / posts.length) / 10 }));
}

// Scans are explicitly bounded for edge CPU/D1 cost. Automatic topic browsing
// and recommendation retrieval use the latest 1,000 eligible posts.
export const TOPIC_SCAN_LIMIT = 1000;

export async function loadTopicInterests(
  db: D1Database,
  userId: string,
  asOfIso: string,
): Promise<Map<string, number>> {
  const result = await db
    .prepare(`
    SELECT p.id, p.text, p.hashtags, MAX(signals.weight) AS weight, MAX(signals.at) AS activity_at
    FROM (
      SELECT post_id, 1.0 AS weight, created_at AS at FROM freshs WHERE user_id = ? AND created_at <= ?
      UNION ALL
      SELECT post_id, 1.5 AS weight, created_at AS at FROM bookmarks WHERE user_id = ? AND created_at <= ?
    ) signals JOIN posts p ON p.id = signals.post_id
    WHERE p.status = 'published' AND p.hidden = 0 AND p.user_id != ?
      AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
      AND signals.at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-90 days')
    GROUP BY p.id ORDER BY activity_at DESC LIMIT 80
  `)
    .bind(userId, asOfIso, userId, asOfIso, userId, userId, asOfIso)
    .all<TopicPost & { weight: number; activity_at: string }>();
  const interests = new Map<string, number>();
  for (const post of result.results || []) {
    const tags = extractTopicTags(post.text, post.hashtags);
    const ageDays = Math.max(0, (Date.parse(asOfIso) - Date.parse(post.activity_at)) / 86400_000);
    const weight = (post.weight * 2 ** (-ageDays / 30)) / Math.max(1, tags.length);
    for (const tag of tags) interests.set(tag, (interests.get(tag) || 0) + weight);
  }
  return interests;
}

export function topicAffinity(tags: string[], interests: Map<string, number>): number {
  const maxInterest = Math.max(0, ...interests.values());
  if (maxInterest === 0 || tags.length === 0) return 0;
  // The strongest matching topic wins; adding unrelated tags cannot inflate it.
  return Math.max(0, ...tags.map((tag) => interests.get(tag) || 0)) / maxInterest;
}
