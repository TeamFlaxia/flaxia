import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyConsecutiveFails,
  bucketAvailability,
  computeUptime,
  nextHistogram,
} from '../status-worker/src/transition.ts';

describe('applyConsecutiveFails', () => {
  it('resets failures on success', () => {
    assert.deepEqual(applyConsecutiveFails('operational', 3), {
      status: 'operational',
      consecutiveFailures: 0,
      spark: 'ok',
    });
  });

  it('first down is shown as degraded (confirming)', () => {
    assert.deepEqual(applyConsecutiveFails('down', 0), {
      status: 'degraded',
      consecutiveFailures: 1,
      spark: 'fail',
    });
  });

  it('second consecutive down becomes down', () => {
    assert.deepEqual(applyConsecutiveFails('down', 1), {
      status: 'down',
      consecutiveFailures: 2,
      spark: 'fail',
    });
  });

  it('degraded increments failures but stays degraded', () => {
    assert.deepEqual(applyConsecutiveFails('degraded', 0), {
      status: 'degraded',
      consecutiveFailures: 1,
      spark: 'slow',
    });
  });

  it('unknown keeps prior failures and no spark', () => {
    assert.deepEqual(applyConsecutiveFails('unknown', 5), {
      status: 'unknown',
      consecutiveFailures: 5,
      spark: null,
    });
  });
});

describe('nextHistogram', () => {
  it('pushes newest sample to front', () => {
    assert.deepEqual(nextHistogram(['fail', 'ok'], 'ok'), ['ok', 'fail', 'ok']);
  });

  it('does not change on null spark', () => {
    assert.deepEqual(nextHistogram(['ok'], null), ['ok']);
  });

  it('caps size', () => {
    const hist = nextHistogram(Array(60).fill('ok'), 'fail', 60);
    assert.equal(hist.length, 60);
    assert.equal(hist[0], 'fail');
  });
});

describe('computeUptime', () => {
  it('computes percentage', () => {
    assert.equal(computeUptime(95, 100), 95);
    assert.equal(computeUptime(1, 3), 33.33);
  });

  it('returns null when no samples', () => {
    assert.equal(computeUptime(0, 0), null);
  });
});

describe('bucketAvailability', () => {
  const now = 1_000_000_000;
  const samples = [
    { checked_at: now - 1000, status: 'operational' },
    { checked_at: now - 500, status: 'down' },
    { checked_at: now - 50, status: 'operational' },
  ];

  it('groups samples into buckets', () => {
    const buckets = bucketAvailability(samples, 60_000, 60_000, now);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].uptime, 66.67);
    assert.equal(buckets[0].sampleCount, 3);
  });

  it('ignores samples older than window', () => {
    const buckets = bucketAvailability(
      [...samples, { checked_at: now - 120_000, status: 'operational' }],
      60_000,
      60_000,
      now,
    );
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].sampleCount, 3);
  });
});
