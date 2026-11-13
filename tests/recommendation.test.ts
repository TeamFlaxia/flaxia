import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankCandidates } from '../src/lib/recommendation/rank.ts';
import { normalizeVector, weightedMeanVector } from '../src/lib/recommendation/vector.ts';
import { decodeVector, encodeVector } from '../src/lib/recommendation/vector-codec.ts';

describe('recommendation vectors', () => {
  it('round-trips int8 vectors within quantization error', () => {
    const vector = Array.from({ length: 1024 }, (_, index) => Math.sin(index / 7) * (index % 11));
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
