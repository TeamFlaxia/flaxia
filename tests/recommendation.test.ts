import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import { isRemoteRecommendation, presentForYou } from '../shared/recommendation/mix.ts';
import { normalizeVector, weightedMeanVector } from '../shared/recommendation/vector.ts';
import { decodeVector, encodeVector } from '../shared/recommendation/vector-codec.ts';
import { rankCandidates } from '../src/lib/recommendation/rank.ts';

// The Hono route module still uses extensionless relative imports, which Node's
// ESM resolver does not accept. Teach this test process to append `.ts` so the
// pure recommendation helpers can be exercised directly (no dev server needed).
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      try {
        return await nextResolve(specifier, context);
      } catch (error) {
        if (error && error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
          return nextResolve(specifier + '.ts', context);
        }
        throw error;
      }
    }
  `)}`,
);
const {
  buildPoolCandidateSql,
  collectRecommendationCandidateIds,
  normalizePoolScore,
  POOL_SCORE_WEIGHT,
  scoreRecommendationCandidate,
} = await import('../functions/api/routes/posts/recommendations.ts');

describe('recommendation vectors', () => {
  it('round-trips int8 vectors within quantization error', () => {
    const vector = Array.from({ length: 768 }, (_, index) => Math.sin(index / 7) * (index % 11));
    const encoded = encodeVector(vector);
    assert.ok(encoded);
    const decoded = decodeVector(encoded, vector.length);
    assert.ok(decoded);
    for (let i = 0; i < vector.length; i++) {
      assert.ok(Math.abs(decoded[i] - vector[i]) <= Math.abs(encoded.scale));
    }
  });

  it('fails closed on malformed vectors', () => {
    assert.equal(encodeVector([]), null);
    assert.equal(encodeVector([1, Number.NaN]), null);
    assert.equal(decodeVector({ scale: 1, data: '***' }, 4), null);
    assert.equal(decodeVector({ scale: 1, data: 'AA==' }, 4), null);
  });

  it('builds a normalized weighted mean and ignores mismatched dimensions', () => {
    const vector = weightedMeanVector(
      [
        { vector: [1, 0, 0], weight: 3 },
        { vector: [0, 1, 0], weight: 1 },
        { vector: [1, 1], weight: 100 },
      ],
      3,
    );
    assert.ok(vector);
    assert.ok(Math.abs(vector[0] - 0.9486832980505138) < 1e-9);
    assert.ok(Math.abs(vector[1] - 0.31622776601683794) < 1e-9);
    assert.equal(vector[2], 0);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-9);
    assert.deepEqual(normalizeVector([0, 0]), [0, 0]);
  });
});

describe('client-side recommendation ranking', () => {
  const profile = [1, 0];

  it('blends cosine relevance with the non-personal base score', () => {
    const items = [
      { id: 'relevant', base: 0.1, vector: [1, 0], author: 'a' },
      { id: 'irrelevant', base: 1, vector: [0, 1], author: 'b' },
    ];
    const ranked = rankCandidates({
      items,
      profile,
      getVector: (item) => item.vector,
      getBaseScore: (item) => item.base,
      getAuthor: (item) => item.author,
      limit: 2,
      personalWeight: 0.9,
      mmrLambda: 1,
    });
    assert.equal(ranked[0].id, 'relevant');
  });

  it('caps repeated authors when a profile is present', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      id: `same-${index}`,
      base: 1 - index / 10,
      vector: [1, 0],
      author: 'spammer',
    }));
    items.push({ id: 'other', base: 0.2, vector: [1, 0], author: 'other' });
    const ranked = rankCandidates({
      items,
      profile,
      getVector: (item) => item.vector,
      getBaseScore: (item) => item.base,
      getAuthor: (item) => item.author,
      limit: 6,
      mmrLambda: 1,
    });
    assert.equal(ranked.filter((item) => item.author === 'spammer').length, 2);
    assert.ok(ranked.some((item) => item.id === 'other'));
  });

  it('preserves base-score order without a profile', () => {
    const items = [
      { id: 'low', base: 0.1, vector: [1, 0] },
      { id: 'high', base: 0.9, vector: [0, 1] },
    ];
    const ranked = rankCandidates({
      items,
      profile: null,
      getVector: (item) => item.vector,
      getBaseScore: (item) => item.base,
      limit: 2,
    });
    assert.deepEqual(
      ranked.map((item) => item.id),
      ['high', 'low'],
    );
  });
});

describe('For You local-only presentation', () => {
  const rows = [
    { id: 'local-1', is_remote: 0 },
    { id: 'remote-1', is_remote: 1, actor_id: 'https://mastodon.example/users/a' },
    { id: 'local-2', is_remote: 0 },
    { id: 'remote-2', is_remote: 1 },
  ];

  it('drops every federated post while preserving local order', () => {
    assert.deepEqual(
      presentForYou(rows, 10).map((row) => row.id),
      ['local-1', 'local-2'],
    );
    assert.deepEqual(presentForYou([], 10), []);
  });

  it('caps the result at the requested limit', () => {
    assert.deepEqual(
      presentForYou(rows, 1).map((row) => row.id),
      ['local-1'],
    );
    assert.deepEqual(presentForYou(rows, 0), []);
  });

  it('recognises remote posts by flag or actor id', () => {
    assert.equal(isRemoteRecommendation({ is_remote: true }), true);
    assert.equal(isRemoteRecommendation({ is_remote: 1 }), true);
    assert.equal(isRemoteRecommendation({ actor_id: 'https://mastodon.example/users/a' }), true);
    assert.equal(isRemoteRecommendation({ user_id: 'local', is_remote: false }), false);
  });

  it('keeps a high-scoring federated candidate out of For You', () => {
    const scored = [
      { id: 'viral-remote', is_remote: 1, actor_id: 'https://mastodon.example/users/a', score: 0.99 },
      { id: 'local-1', is_remote: 0, score: 0.4 },
      { id: 'local-2', is_remote: 0, score: 0.3 },
    ];
    assert.deepEqual(
      presentForYou(scored, 3).map((row) => row.id),
      ['local-1', 'local-2'],
    );
  });
});

describe('federated popularity pool', () => {
  it('normalizes raw pool scores into a bounded 0..1 term', () => {
    assert.equal(normalizePoolScore(null), 0);
    assert.equal(normalizePoolScore(undefined), 0);
    assert.equal(normalizePoolScore(0), 0);
    assert.equal(normalizePoolScore(-5), 0);
    assert.equal(normalizePoolScore(Number.NaN), 0);
    assert.ok(normalizePoolScore(1) > 0);
    assert.ok(normalizePoolScore(10) > normalizePoolScore(1));
    assert.equal(normalizePoolScore(50), 1);
    assert.equal(normalizePoolScore(5000), 1);
  });

  it('adds only a small bounded pool term to the base score', () => {
    const input = { sourceScore: 0.7, popularity: 0.4, freshness: 0.9, contentQuality: 1 };
    const local = scoreRecommendationCandidate({ ...input, poolScore: 0 });
    const viral = scoreRecommendationCandidate({ ...input, poolScore: 5000 });
    assert.ok(viral > local);
    assert.ok(Math.abs(viral - local - POOL_SCORE_WEIGHT) < 1e-9);
    // The pool term alone can never outrank a strong local source score.
    assert.ok(viral < 1);
  });

  it('includes the pool term in base_scores so vector-less candidates can be ranked', () => {
    const base = { sourceScore: 0.5, popularity: 0.3, freshness: 0.5, contentQuality: 0.7 };
    const poolBase = scoreRecommendationCandidate({ ...base, poolScore: 50 });
    const plainBase = scoreRecommendationCandidate({ ...base, poolScore: 0 });
    assert.ok(poolBase > plainBase);
    const ranked = rankCandidates({
      items: [
        { id: 'remote-pool', base: poolBase, vector: null },
        { id: 'local', base: plainBase, vector: null },
      ],
      profile: [1, 0],
      getVector: (item) => item.vector,
      getBaseScore: (item) => item.base,
      limit: 1,
    });
    assert.equal(ranked[0].id, 'remote-pool');
  });

  it('feeds pool ids into the deduplicated candidate set', () => {
    const ids = collectRecommendationCandidateIds(
      ['following-1'],
      ['trending-1'],
      ['recent-1', 'following-1'],
      ['remote-pool-1', 'recent-1'],
    );
    assert.deepEqual(ids, ['following-1', 'trending-1', 'recent-1', 'remote-pool-1']);
    assert.ok(ids.includes('remote-pool-1'));
  });

  it('builds a remote-only candidate query ordered by pool score', () => {
    const sql = buildPoolCandidateSql('');
    assert.match(sql, /ap_pool_metrics/);
    assert.match(sql, /COALESCE\(pm\.score, 0\) AS pool_score/);
    assert.match(sql, /p\.actor_id IS NOT NULL/);
    assert.match(sql, /ORDER BY pool_score DESC LIMIT \?/);
  });
});
