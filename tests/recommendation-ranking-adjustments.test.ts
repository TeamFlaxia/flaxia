import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTHOR_DIVERSITY_DECAY,
  AUTHOR_DIVERSITY_FLOOR,
  applyAuthorDiversityDecay,
  applyNewAuthorBoost,
  authorDiversityMultiplier,
  isNewAuthor,
  NEW_AUTHOR_IMPRESSION_THRESHOLD,
  NEW_AUTHOR_POST_COUNT_THRESHOLD,
} from '../functions/lib/recommendation-adjustments.ts';

interface Item {
  id: string;
  author: string;
  score: number;
}

const authorOf = (item: Item): string => item.author;

describe('author-diversity decay', () => {
  it('leaves the first post from an author untouched', () => {
    assert.equal(authorDiversityMultiplier(0), 1);
  });

  it('decays each repeated post and never drops below the floor', () => {
    const first = authorDiversityMultiplier(1);
    assert.ok(
      Math.abs(first - ((1 - AUTHOR_DIVERSITY_FLOOR) * AUTHOR_DIVERSITY_DECAY + AUTHOR_DIVERSITY_FLOOR)) < 1e-12,
    );
    assert.ok(authorDiversityMultiplier(2) < first);
    for (const repeats of [3, 10, 1000]) {
      assert.ok(authorDiversityMultiplier(repeats) >= AUTHOR_DIVERSITY_FLOOR);
    }
    assert.ok(Math.abs(authorDiversityMultiplier(1000) - AUTHOR_DIVERSITY_FLOOR) < 1e-9);
  });

  it('tolerates invalid repeats and out-of-range tuning', () => {
    assert.equal(authorDiversityMultiplier(Number.NaN), 1);
    assert.equal(authorDiversityMultiplier(-4), 1);
    assert.equal(authorDiversityMultiplier(1, Number.NaN, 0.4), 1);
    assert.equal(authorDiversityMultiplier(1, 0.5, 1), 1);
    assert.equal(authorDiversityMultiplier(1, 0.5, 0), 0.5);
  });

  it('applies after the author cap, re-sorts, and does not mutate its input', () => {
    const page: Item[] = [
      { id: 'a1', author: 'a', score: 1 },
      { id: 'b1', author: 'b', score: 0.9 },
      { id: 'a2', author: 'a', score: 0.95 },
    ];
    const adjusted = applyAuthorDiversityDecay(page, authorOf);
    assert.deepEqual(
      adjusted.map((item) => item.id),
      ['a1', 'b1', 'a2'],
    );
    assert.equal(adjusted.find((item) => item.id === 'a1')?.score, 1);
    assert.ok(Math.abs(adjusted.find((item) => item.id === 'a2')!.score - 0.95 * 0.85) < 1e-12);
    assert.deepEqual(
      page.map((item) => item.score),
      [1, 0.9, 0.95],
    );
  });

  it('keeps at least the floor for an author that fills every slot', () => {
    const page = Array.from({ length: 4 }, (_, index) => ({ id: `a${index}`, author: 'a', score: 0.6 }));
    const adjusted = applyAuthorDiversityDecay(page, authorOf);
    assert.equal(adjusted.length, 4);
    for (const item of adjusted) {
      assert.ok(item.score >= 0.6 * AUTHOR_DIVERSITY_FLOOR);
      assert.ok(item.score > 0);
    }
  });
});

describe('new-author boost', () => {
  const stats = new Map([
    ['new', { postCount: 1, impressions: 0 }],
    ['established', { postCount: 20, impressions: 900 }],
  ]);

  it('recognises low-impression, low-post-count authors only', () => {
    assert.equal(isNewAuthor(undefined), false);
    assert.equal(isNewAuthor(stats.get('new')), true);
    assert.equal(isNewAuthor(stats.get('established')), false);
    assert.equal(isNewAuthor({ postCount: NEW_AUTHOR_POST_COUNT_THRESHOLD, impressions: 0 }), true);
    assert.equal(isNewAuthor({ postCount: 1, impressions: NEW_AUTHOR_IMPRESSION_THRESHOLD }), false);
  });

  it('lifts eligible authors to the target rank without changing others', () => {
    const items: Item[] = [
      { id: 'top', author: 'established', score: 1 },
      { id: 'second', author: 'established', score: 0.8 },
      { id: 'third', author: 'established', score: 0.6 },
      { id: 'newcomer', author: 'new', score: 0.1 },
      { id: 'other', author: 'unknown', score: 0.4 },
    ];
    const boosted = applyNewAuthorBoost(items, authorOf, stats, 2);
    const byId = new Map(boosted.map((item) => [item.id, item.score]));
    assert.equal(byId.get('newcomer'), 0.6);
    assert.equal(byId.get('other'), 0.4);
    assert.equal(byId.get('top'), 1);
    assert.deepEqual(
      items.map((item) => item.score),
      [1, 0.8, 0.6, 0.1, 0.4],
    );
  });

  it('never lifts an author above the current leader', () => {
    const items: Item[] = [
      { id: 'leader', author: 'established', score: 0.9 },
      { id: 'newcomer', author: 'new', score: 0.2 },
    ];
    const boosted = applyNewAuthorBoost(items, authorOf, stats, 0);
    assert.equal(boosted.find((item) => item.id === 'newcomer')?.score, 0.9);
  });

  it('keeps strong new authors and clamps the target rank', () => {
    const items: Item[] = [
      { id: 'a', author: 'new', score: 0.7 },
      { id: 'b', author: 'established', score: 0.5 },
    ];
    assert.equal(applyNewAuthorBoost(items, authorOf, stats, 2)[0]?.score, 0.7);
    assert.equal(applyNewAuthorBoost([], authorOf, stats).length, 0);
    assert.equal(applyNewAuthorBoost(items, authorOf, stats, -5)[0]?.score, 0.7);
    assert.deepEqual(applyNewAuthorBoost(items, authorOf, new Map()), items);
  });
});
