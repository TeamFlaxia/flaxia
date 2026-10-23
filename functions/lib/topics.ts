import type { D1Database } from '@cloudflare/workers-types';

export interface TopicPost {
  id: string;
  text: string;
  hashtags: string | null;
  auto_topic_tags?: string | null;
}

export function normalizeTag(tag: string): string {
  return tag.normalize('NFKC').replace(/^#+/, '').trim().toLowerCase();
}

/** Canonical topic labels are semantic anchors, not keyword matching rules. */
export const TOPIC_VERSION = 'qwen-topics-v1';
export const TOPIC_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
export const TOPIC_DIMENSIONS = 1024;
export const TOPIC_DEFINITIONS = [
  {
    tag: 'ゲーム',
    description: 'ビデオゲームを遊ぶ、制作する、攻略する話題。Playing, creating and discussing video games.',
  },
  {
    tag: 'プログラミング',
    description: 'ソフトウェア開発、コード、デバッグについて。Programming, software engineering and debugging code.',
  },
  {
    tag: 'ai',
    description: '人工知能、機械学習、生成AIについて。Artificial intelligence, machine learning and generative models.',
  },
  {
    tag: '音楽',
    description: '楽曲を聴く、作曲する、演奏する話題。Listening to music, composing songs and playing instruments.',
  },
  {
    tag: 'イラスト',
    description: '絵を描く、イラストを制作する、美術について。Drawing, illustration, painting and visual arts.',
  },
  {
    tag: 'アニメ',
    description: 'アニメーション作品や漫画を楽しむ話題。Watching anime, reading manga and discussing their characters.',
  },
  {
    tag: '写真',
    description: '写真を撮る、撮影技術やカメラについて。Photography, taking pictures and camera techniques.',
  },
  {
    tag: '料理',
    description: '食事を作る、料理のレシピ、お菓子やパン作り。Cooking meals, recipes, baking cakes and bread.',
  },
  {
    tag: '旅行',
    description: '旅先を訪ねる、観光や旅行の体験。Traveling, visiting destinations and sightseeing experiences.',
  },
  { tag: 'スポーツ', description: '競技や運動、チームの試合について。Sports, exercise, athletics and team matches.' },
  {
    tag: '科学',
    description: '自然科学の研究、宇宙や物理の現象。Scientific research, astronomy, physics and natural phenomena.',
  },
  {
    tag: '読書',
    description: '本や小説を読む、感想や書評について。Reading books and novels, literature and book reviews.',
  },
  {
    tag: '__other__',
    description:
      '日常のあいさつ、近況、分類できない雑談。Everyday greetings, personal updates and miscellaneous conversation.',
  },
] as const;

export function postTopicTags(post: Pick<TopicPost, 'hashtags' | 'auto_topic_tags'>): string[] {
  const tags = new Set<string>();
  for (const json of [post.hashtags, post.auto_topic_tags]) {
    try {
      const parsed: unknown = JSON.parse(json || '[]');
      if (!Array.isArray(parsed)) continue;
      for (const tag of parsed) {
        if (typeof tag !== 'string') continue;
        const normalized = normalizeTag(tag);
        if (/^[\p{L}\p{N}_ー]{1,40}$/u.test(normalized)) tags.add(normalized);
      }
    } catch {
      /* Ignore malformed historical tags. */
    }
  }
  return [...tags];
}

export function parseTopicVector(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.length === TOPIC_DIMENSIONS &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    value.some((n) => n !== 0)
    ? value
    : null;
}

export interface TopicPrototype {
  tag: string;
  vector: number[];
}

export function classifyTopicVector(vector: number[], prototypes: TopicPrototype[]): string[] {
  if (
    !parseTopicVector(vector) ||
    !TOPIC_DEFINITIONS.every((topic) => prototypes.some((p) => p.tag === topic.tag && parseTopicVector(p.vector)))
  )
    return [];
  const norm = Math.hypot(...vector);
  const scores = prototypes
    .map((prototype) => ({
      tag: prototype.tag,
      score:
        vector.reduce((sum, value, index) => sum + value * prototype.vector[index], 0) /
        (norm * Math.hypot(...prototype.vector)),
    }))
    .sort((a, b) => b.score - a.score);
  const best = scores[0].score;
  if (scores[0].tag === '__other__') return [];
  // Similarity is not a probability. These initial thresholds require evaluation
  // on real multilingual posts; low-confidence and miscellaneous posts stay untagged.
  return scores
    .filter((item) => item.tag !== '__other__' && item.score >= 0.5 && item.score >= best - 0.08)
    .slice(0, 3)
    .map((item) => item.tag);
}

export async function textSha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function loadTopicPrototypes(db: D1Database): Promise<TopicPrototype[]> {
  const rows = await db
    .prepare('SELECT tag, embedding FROM topic_prototypes WHERE version = ? AND model = ? AND embedding IS NOT NULL')
    .bind(TOPIC_VERSION, TOPIC_MODEL)
    .all<{ tag: string; embedding: string }>();
  const prototypes: TopicPrototype[] = [];
  for (const row of rows.results || []) {
    try {
      const vector = parseTopicVector(JSON.parse(row.embedding));
      if (vector) prototypes.push({ tag: row.tag, vector });
    } catch {
      /* Ignore corrupt model output. */
    }
  }
  return prototypes;
}

export async function backfillTopicTags(db: D1Database): Promise<void> {
  const prototypes = await loadTopicPrototypes(db);
  if (prototypes.length !== TOPIC_DEFINITIONS.length) return;
  const rows = await db
    .prepare(`
    SELECT p.id, p.text, e.embedding, e.source_sha FROM posts p JOIN post_embeddings e ON e.post_id = p.id
    WHERE p.status = 'published' AND p.hidden = 0 AND e.model = ? AND e.source_sha IS NOT NULL
      AND (p.auto_topic_version IS NULL OR p.auto_topic_version != ?)
    ORDER BY p.created_at DESC LIMIT 50
  `)
    .bind(TOPIC_MODEL, TOPIC_VERSION)
    .all<{ id: string; text: string; embedding: string; source_sha: string }>();
  for (const row of rows.results || []) {
    let vector: number[] | null;
    try {
      vector = parseTopicVector(JSON.parse(row.embedding));
    } catch {
      continue;
    }
    if (!vector || (await textSha(row.text)) !== row.source_sha) continue;
    const tags = classifyTopicVector(vector, prototypes);
    await db
      .prepare('UPDATE posts SET auto_topic_tags = ?, auto_topic_version = ? WHERE id = ? AND text = ?')
      .bind(JSON.stringify(tags), TOPIC_VERSION, row.id, row.text)
      .run();
  }
}

export function aggregateTopicTags(posts: TopicPost[], limit = 5) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of postTopicTags(post)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts]
    .sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count, percentage: Math.round((count * 1000) / posts.length) / 10 }));
}

// Recommendation candidate scans are bounded for edge CPU/D1 cost.
export const TOPIC_SCAN_LIMIT = 1000;

export async function loadTopicInterests(
  db: D1Database,
  userId: string,
  asOfIso: string,
): Promise<Map<string, number>> {
  const result = await db
    .prepare(`
    SELECT p.id, p.text, p.hashtags, p.auto_topic_tags, MAX(signals.weight) AS weight, MAX(signals.at) AS activity_at
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
    const tags = postTopicTags(post);
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
