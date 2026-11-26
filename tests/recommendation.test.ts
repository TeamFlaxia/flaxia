import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRemoteRecommendation, mixForYouFeed, presentForYou } from '../shared/recommendation/mix.ts';
import { normalizeVector, weightedMeanVector } from '../shared/recommendation/vector.ts';
import { decodeVector, encodeVector } from '../shared/recommendation/vector-codec.ts';
import { rankCandidates } from '../src/lib/recommendation/rank.ts';

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

describe('For You source mixing', () => {
  const local = (n: number) => `local-${n}`;
  const remote = (n: number) => `remote-${n}`;
  const items = [...Array.from({ length: 6 }, (_, i) => local(i)), ...Array.from({ length: 6 }, (_, i) => remote(i))];
  const source = (id: string) => (id.startsWith('remote') ? ('remote' as const) : ('local' as const));

  it('alternates 1:1 with Flaxia taking the first slot', () => {
    const mixed = mixForYouFeed({ items, getSource: source, limit: 8 });
    assert.deepEqual(mixed.map(source), ['local', 'remote', 'local', 'remote', 'local', 'remote', 'local', 'remote']);
    assert.equal(mixed[0], 'local-0');
  });

  it('keeps per-side order', () => {
    const mixed = mixForYouFeed({ items, getSource: source, limit: 4 });
    assert.deepEqual(mixed, ['local-0', 'remote-0', 'local-1', 'remote-1']);
  });

  it('fills the remaining slots from the longer side', () => {
    const skewed = ['local-0', 'local-1', 'local-2', 'remote-0'];
    assert.deepEqual(mixForYouFeed({ items: skewed, getSource: source, limit: 4 }), [
      'local-0',
      'remote-0',
      'local-1',
      'local-2',
    ]);
    assert.deepEqual(mixForYouFeed({ items: ['remote-0', 'remote-1'], getSource: source, limit: 4 }), [
      'remote-0',
      'remote-1',
    ]);
  });

  it('honours the "do not show" choice', () => {
    const mixed = mixForYouFeed({ items, getSource: source, limit: 6, hideRemote: true });
    assert.ok(mixed.every((id) => source(id) === 'local'));
    assert.deepEqual(mixed, ['local-0', 'local-1', 'local-2', 'local-3', 'local-4', 'local-5']);
  });

  it('handles empty input and zero limits', () => {
    assert.deepEqual(mixForYouFeed({ items, getSource: source, limit: 0 }), []);
    assert.deepEqual(mixForYouFeed({ items: [], getSource: source, limit: 10 }), []);
  });

  it('recognises remote posts by flag or actor id', () => {
    assert.equal(isRemoteRecommendation({ is_remote: true }), true);
    assert.equal(isRemoteRecommendation({ is_remote: 1 }), true);
    assert.equal(isRemoteRecommendation({ actor_id: 'https://mastodon.example/users/a' }), true);
    assert.equal(isRemoteRecommendation({ user_id: 'local', is_remote: false }), false);
  });

  it('presentForYou mixes raw D1 rows (is_remote is 0/1)', () => {
    const rows = [
      { id: 'local-1', is_remote: 0 },
      { id: 'remote-1', is_remote: 1, actor_id: 'https://mastodon.example/users/a' },
      { id: 'local-2', is_remote: 0 },
      { id: 'remote-2', is_remote: 1 },
    ];
    assert.deepEqual(
      presentForYou(rows, 4, false, true).map((row) => row.id),
      ['local-1', 'remote-1', 'local-2', 'remote-2'],
    );
    assert.deepEqual(
      presentForYou(rows, 4, true, true).map((row) => row.id),
      ['local-1', 'local-2'],
    );
  });

  it('presentForYou hides remote candidates without mixing for client ranking', () => {
    const rows = [
      { id: 'local-1', is_remote: 0 },
      { id: 'remote-1', is_remote: 1 },
      { id: 'local-2', is_remote: 0 },
    ];
    assert.deepEqual(
      presentForYou(rows, 3, true, false).map((row) => row.id),
      ['local-1', 'local-2'],
    );
    assert.deepEqual(
      presentForYou(rows, 3, false, false).map((row) => row.id),
      ['local-1', 'remote-1', 'local-2'],
    );
  });
});
