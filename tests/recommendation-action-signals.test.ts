import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveActionSignals } from '../functions/lib/recommendation-candidates.ts';
import {
  ACTION_SIGNAL_WEIGHTS,
  type ActionSignalName,
  actionSignalScore,
  normalizeActionSignal,
  scoreRecommendationCandidate,
} from '../functions/lib/recommendation-scoring.ts';

const BASE = { sourceScore: 0.6, popularity: 0.35, freshness: 0.7, contentQuality: 1 };
const NAMES = Object.keys(ACTION_SIGNAL_WEIGHTS) as ActionSignalName[];

describe('action-signal normalization', () => {
  it('clamps predictions into 0..1', () => {
    assert.equal(normalizeActionSignal(0.4), 0.4);
    assert.equal(normalizeActionSignal(-2), 0);
    assert.equal(normalizeActionSignal(7), 1);
  });

  it('treats missing and non-finite predictions as zero', () => {
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(normalizeActionSignal(value), 0);
    }
    assert.equal(normalizeActionSignal('0.5' as unknown as number), 0);
  });
});

describe('candidate signal hydration', () => {
  it('uses reload_count as the share propensity proxy without touching other signals', () => {
    assert.deepEqual(deriveActionSignals({ reload_count: 5 }, 10), { share: 0.5 });
    assert.deepEqual(deriveActionSignals({ reload_count: 20 }, 10), { share: 1 });
    assert.deepEqual(deriveActionSignals({ reload_count: 3 }, 0), { share: 0 });
    assert.deepEqual(deriveActionSignals({}, 10), { share: 0 });
    assert.deepEqual(deriveActionSignals({ reload_count: Number.NaN }, 10), { share: 0 });
  });
});

describe('explicit action-signal weights', () => {
  it('adds exactly one named weight per full signal', () => {
    const plain = scoreRecommendationCandidate(BASE);
    for (const name of NAMES) {
      const withSignal = scoreRecommendationCandidate({ ...BASE, actionSignals: { [name]: 1 } });
      assert.ok(
        Math.abs(withSignal - plain - ACTION_SIGNAL_WEIGHTS[name]) < 1e-12,
        `${name} should add its own weight only`,
      );
    }
  });

  it('scales each contribution linearly with the predicted value', () => {
    const plain = scoreRecommendationCandidate(BASE);
    for (const name of NAMES) {
      const half = scoreRecommendationCandidate({ ...BASE, actionSignals: { [name]: 0.5 } });
      assert.ok(Math.abs(half - plain - ACTION_SIGNAL_WEIGHTS[name] / 2) < 1e-12);
    }
  });

  it('sums independent signals and stays bounded', () => {
    const plain = scoreRecommendationCandidate(BASE);
    const all = scoreRecommendationCandidate({
      ...BASE,
      actionSignals: { fresh: 1, bookmark: 1, reply: 1, share: 1, view: 1, dwell: 1 },
    });
    const budget = Object.values(ACTION_SIGNAL_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    assert.ok(Math.abs(all - plain - budget) < 1e-12);
    assert.equal(actionSignalScore(), 0);
    assert.ok(
      Math.abs(actionSignalScore({ fresh: 2, bookmark: -1, reply: Number.NaN }) - ACTION_SIGNAL_WEIGHTS.fresh) < 1e-12,
    );
  });

  it('leaves the source and popularity terms untouched', () => {
    // Signals are an added term, not a second count of the same engagement.
    const lowPopularity = scoreRecommendationCandidate({ ...BASE, popularity: 0.1, actionSignals: { share: 1 } });
    const highPopularity = scoreRecommendationCandidate({ ...BASE, popularity: 0.9, actionSignals: { share: 1 } });
    const popularityDelta =
      scoreRecommendationCandidate({ ...BASE, popularity: 0.9 }) -
      scoreRecommendationCandidate({ ...BASE, popularity: 0.1 });
    assert.ok(Math.abs(highPopularity - lowPopularity - popularityDelta) < 1e-12);
  });

  it('does not change the score when no signals are supplied', () => {
    assert.equal(scoreRecommendationCandidate(BASE), scoreRecommendationCandidate({ ...BASE, actionSignals: {} }));
  });

  it('applies the existing history penalty after action signals', () => {
    const plain = scoreRecommendationCandidate(BASE);
    const boosted = scoreRecommendationCandidate({ ...BASE, actionSignals: { dwell: 1 } });
    const penalizedPlain = scoreRecommendationCandidate({ ...BASE, historyPenalty: 0.4 });
    const penalizedBoosted = scoreRecommendationCandidate({
      ...BASE,
      actionSignals: { dwell: 1 },
      historyPenalty: 0.4,
    });
    assert.ok(Math.abs(penalizedBoosted - penalizedPlain - (boosted - plain) * 0.6) < 1e-12);
  });
});
