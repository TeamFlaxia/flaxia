export const TRUST_WINDOW_DAYS = 30;
export const TRUST_MAX_POSTS = 60;
export const TRUST_MIN_CLUSTER_SIZE = 3;
export const REPETITION_DUPLICATE_THRESHOLD = 0.75;
export const MIN_TRUST_SCORE = 0.1;
export const RECOMMENDATION_MIN_TRUST = 0.6;

const SHINGLE_SIZE = 3;
const SHORT_TEXT_LENGTH = 8;

const URL_PATTERN = /https?:\/\/\S+/giu;
const TAG_PATTERN = /[@#][\p{L}\p{N}_]+/gu;
const IGNORED_CHARACTER_PATTERN = /[\s\p{P}\p{S}\p{Cf}]+/gu;

export interface TrustSnapshot {
  trustScore: number;
  repetitionScore: number;
}

export function normalizePostText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(URL_PATTERN, ' ')
    .replace(TAG_PATTERN, ' ')
    .replace(IGNORED_CHARACTER_PATTERN, '');
}

function buildShingles(normalized: string): Set<string> | null {
  if (!normalized) return null;
  if (normalized.length < SHORT_TEXT_LENGTH) return new Set([normalized]);
  const result = new Set<string>();
  for (let index = 0; index + SHINGLE_SIZE <= normalized.length; index++) {
    result.add(normalized.slice(index, index + SHINGLE_SIZE));
  }
  return result;
}

function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const shingle of small) {
    if (large.has(shingle)) intersection++;
  }
  return (2 * intersection) / (a.size + b.size);
}

interface TextFeatures {
  normalized: string;
  shingles: Set<string> | null;
}

function buildFeatures(text: string): TextFeatures {
  const normalized = normalizePostText(text);
  return { normalized, shingles: buildShingles(normalized) };
}

function areNearDuplicates(a: TextFeatures, b: TextFeatures): boolean {
  if (!a.normalized || !b.normalized) return false;
  if (a.normalized === b.normalized) return true;
  if (Math.min(a.normalized.length, b.normalized.length) < SHORT_TEXT_LENGTH) return false;
  if (!a.shingles || !b.shingles) return false;
  return diceCoefficient(a.shingles, b.shingles) >= REPETITION_DUPLICATE_THRESHOLD;
}

export function isNearDuplicateText(a: string, b: string): boolean {
  return areNearDuplicates(buildFeatures(a), buildFeatures(b));
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    while (this.parent[index] !== index) {
      const next = this.parent[index] as number;
      this.parent[index] = root;
      index = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

export function computeRepetitionScore(texts: string[]): number {
  if (texts.length < TRUST_MIN_CLUSTER_SIZE) return 0;
  const features = texts.map(buildFeatures).filter((feature) => feature.normalized.length > 0);
  if (features.length < TRUST_MIN_CLUSTER_SIZE) return 0;

  const groups = new DisjointSet(features.length);
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      if (areNearDuplicates(features[i] as TextFeatures, features[j] as TextFeatures)) {
        groups.union(i, j);
      }
    }
  }

  const sizes = new Map<number, number>();
  for (let index = 0; index < features.length; index++) {
    const root = groups.find(index);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }

  let repeated = 0;
  for (const size of sizes.values()) {
    if (size >= TRUST_MIN_CLUSTER_SIZE) repeated += size;
  }
  return Math.min(1, repeated / texts.length);
}

export function trustScoreFromRepetition(repetitionScore: number): number {
  const bounded = Math.min(1, Math.max(0, repetitionScore));
  return Math.max(MIN_TRUST_SCORE, 1 - bounded);
}

export async function refreshUserTrust(db: D1Database, userId: string, now = new Date()): Promise<TrustSnapshot> {
  const cutoff = new Date(now.getTime() - TRUST_WINDOW_DAYS * 86_400_000).toISOString();
  const result = await db
    .prepare(
      `SELECT text FROM posts
       WHERE user_id = ? AND actor_id IS NULL AND status = 'published' AND hidden = 0 AND parent_id IS NULL
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(userId, cutoff, TRUST_MAX_POSTS)
    .all<{ text: string | null }>();
  const repetitionScore = computeRepetitionScore((result.results || []).map((row) => row.text || ''));
  const trustScore = trustScoreFromRepetition(repetitionScore);
  await db
    .prepare('UPDATE users SET trust_score = ?, repetition_score = ?, trust_updated_at = ? WHERE id = ?')
    .bind(trustScore, repetitionScore, now.toISOString(), userId)
    .run();
  return { trustScore, repetitionScore };
}

export async function refreshUserTrustSafe(
  db: D1Database,
  userId: string,
  now = new Date(),
): Promise<TrustSnapshot | null> {
  try {
    return await refreshUserTrust(db, userId, now);
  } catch (error: unknown) {
    console.error('Trust score refresh failed:', error);
    return null;
  }
}

export async function recomputeStaleTrustScores(db: D1Database, limit = 100): Promise<number> {
  const cutoff = new Date(Date.now() - TRUST_WINDOW_DAYS * 86_400_000).toISOString();
  const result = await db
    .prepare(
      `SELECT id FROM users
       WHERE trust_score < 1.0
          OR (trust_updated_at IS NULL AND id IN (
            SELECT user_id FROM posts
            WHERE actor_id IS NULL AND status = 'published' AND hidden = 0 AND parent_id IS NULL
              AND created_at >= ?
          ))
       ORDER BY trust_updated_at ASC
       LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<{ id: string }>();

  let updated = 0;
  for (const row of result.results || []) {
    const snapshot = await refreshUserTrustSafe(db, row.id);
    if (snapshot) updated++;
  }
  return updated;
}
