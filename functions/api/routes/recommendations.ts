import { Hono } from 'hono';
import {
  type EncodedVector,
  encodeVector,
  RECOMMENDATION_VECTOR_DIM,
} from '../../../src/lib/recommendation/vector-codec.ts';
import { checkRateLimit } from '../../lib/rate-limit';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const recommendations = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type SignalKind = 'fresh' | 'bookmark' | 'reply' | 'share' | 'dwell';

interface SignalRow {
  post_id: string;
  created_at: string | null;
  dwell_ms?: number | null;
}

interface SignalSource {
  post_id: string;
  kind: SignalKind;
  weight: number;
  created_at?: string;
  vector?: EncodedVector;
}

const BASE_WEIGHTS: Record<SignalKind, number> = {
  fresh: 1.0,
  bookmark: 1.2,
  reply: 1.4,
  share: 1.3,
  dwell: 1.0,
};

const MAX_SOURCE_POSTS = 150;
const MAX_WEIGHT_PER_POST = 2.5;
const RECENCY_HALF_LIFE_DAYS = 30;

function recencyWeight(createdAt: string | null | undefined, nowMs: number): number {
  if (!createdAt) return 1;
  const ageMs = Date.parse(createdAt);
  if (!Number.isFinite(ageMs)) return 1;
  const ageDays = Math.max(0, nowMs - ageMs) / 86_400_000;
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Return the caller's own interaction signals plus public post embeddings.
 * The preference vector itself is never computed here: the unlocked browser
 * builds and stores it inside the Personal Vault.
 */
recommendations.get('/recommendations/profile-sources', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

  // This response contains the caller's own interaction history; never let a
  // shared cache retain it, including the empty-sources early return below.
  c.header('Cache-Control', 'no-store');

  if (
    !(await checkRateLimit(c.env.CACHE, `recommendation-profile:${user.id}`, {
      maxRequests: 30,
      windowSeconds: 60,
    }))
  ) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  try {
    const [freshRows, bookmarkRows, replyRows, shareRows, dwellRows] = await Promise.all([
      c.env.DB.prepare(
        `SELECT f.post_id, f.created_at FROM freshs f JOIN posts p ON p.id = f.post_id
         WHERE f.user_id = ? AND p.status = 'published' AND p.hidden = 0
         ORDER BY f.created_at DESC LIMIT 40`,
      )
        .bind(user.id)
        .all<SignalRow>(),
      c.env.DB.prepare(
        `SELECT b.post_id, b.created_at FROM bookmarks b JOIN posts p ON p.id = b.post_id
         WHERE b.user_id = ? AND p.status = 'published' AND p.hidden = 0
         ORDER BY b.created_at DESC LIMIT 30`,
      )
        .bind(user.id)
        .all<SignalRow>(),
      c.env.DB.prepare(
        `SELECT p.parent_id AS post_id, p.created_at FROM posts p
         WHERE p.user_id = ? AND p.parent_id IS NOT NULL
           AND p.status = 'published' AND p.hidden = 0
         ORDER BY p.created_at DESC LIMIT 30`,
      )
        .bind(user.id)
        .all<SignalRow>(),
      c.env.DB.prepare(
        `SELECT s.post_id, s.created_at FROM shares s JOIN posts p ON p.id = s.post_id
         WHERE s.user_id = ? AND p.status = 'published' AND p.hidden = 0
         ORDER BY s.created_at DESC LIMIT 30`,
      )
        .bind(user.id)
        .all<SignalRow>(),
      c.env.DB.prepare(
        `SELECT g.post_id, g.dwell_ms, g.created_at FROM user_game_plays g
         JOIN posts p ON p.id = g.post_id
         WHERE g.user_id = ? AND g.dwell_ms > 5000
           AND p.status = 'published' AND p.hidden = 0
         ORDER BY g.created_at DESC LIMIT 50`,
      )
        .bind(user.id)
        .all<SignalRow>(),
    ]);

    const nowMs = Date.now();
    const weights = new Map<string, { weight: number; kind: SignalKind; latest: string }>();

    const add = (rows: SignalRow[] | undefined, kind: SignalKind) => {
      for (const row of rows ?? []) {
        if (!row.post_id) continue;
        const base =
          kind === 'dwell' ? Math.min(Math.max(0, Number(row.dwell_ms) || 0) / 30_000, 1) : BASE_WEIGHTS[kind];
        if (base <= 0) continue;
        const decayed = base * recencyWeight(row.created_at, nowMs);
        const current = weights.get(row.post_id);
        const latest = row.created_at || current?.latest || '';
        weights.set(row.post_id, {
          weight: Math.min(MAX_WEIGHT_PER_POST, (current?.weight || 0) + decayed),
          kind: current?.kind || kind,
          latest: current && current.latest > latest ? current.latest : latest,
        });
      }
    };

    add(freshRows.results, 'fresh');
    add(bookmarkRows.results, 'bookmark');
    add(replyRows.results, 'reply');
    add(shareRows.results, 'share');
    add(dwellRows.results, 'dwell');

    const ordered = [...weights.entries()]
      .sort((a, b) => b[1].weight - a[1].weight || b[1].latest.localeCompare(a[1].latest))
      .slice(0, MAX_SOURCE_POSTS);
    const sourceIds = ordered.map(([postId]) => postId);
    const latestSignal = ordered.reduce(
      (latest, [, value]) => (value.latest.localeCompare(latest) > 0 ? value.latest : latest),
      '',
    );

    if (sourceIds.length === 0) {
      return c.json({
        v: 1,
        dim: RECOMMENDATION_VECTOR_DIM,
        encoding: 'int8',
        sources: [],
        source_version: '',
      });
    }

    const embeddings = await c.env.DB.prepare(
      'SELECT post_id, embedding FROM post_embeddings WHERE post_id IN (SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(sourceIds))
      .all<{ post_id: string; embedding: string }>();

    const embeddingById = new Map<string, number[]>();
    for (const row of embeddings.results ?? []) {
      try {
        const vector: unknown = JSON.parse(row.embedding);
        if (Array.isArray(vector) && vector.length === RECOMMENDATION_VECTOR_DIM) {
          embeddingById.set(row.post_id, vector.map(Number));
        }
      } catch {
        // A malformed embedding is omitted; other signals still count.
      }
    }

    const sources: SignalSource[] = [];
    for (const [postId, signal] of ordered) {
      const vector = embeddingById.get(postId);
      if (!vector) continue;
      const encoded = encodeVector(vector);
      if (!encoded) continue;
      sources.push({
        post_id: postId,
        kind: signal.kind,
        weight: signal.weight,
        created_at: signal.latest || undefined,
        vector: encoded,
      });
    }

    return c.json({
      v: 1,
      dim: RECOMMENDATION_VECTOR_DIM,
      encoding: 'int8',
      sources,
      source_version: `${latestSignal}|${sources.length}`,
    });
  } catch (error: unknown) {
    console.error('Recommendation profile sources error:', error);
    return c.json({ error: 'Failed to load recommendation sources' }, 500);
  }
});

export default recommendations;
