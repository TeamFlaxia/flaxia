// Pure status-transition helpers used by the status worker and its tests.
// A probe reports one of four states; the helpers turn a stream of probe
// results into a user-facing status, a failure counter, and a sparkline sample.

export type ProbeStatus = 'operational' | 'down' | 'degraded' | 'unknown';
export type SparkSample = 'ok' | 'fail' | 'slow' | null;

export interface FailureTransition {
  status: ProbeStatus;
  consecutiveFailures: number;
  spark: SparkSample;
}

const DOWN_THRESHOLD = 2;

/**
 * Fold a fresh probe result into the running failure counter.
 *
 * A single `down` is reported as `degraded` ("confirming") and only the second
 * consecutive failure promotes it to `down`, which avoids flapping on a
 * one-off blip. Success resets the counter.
 */
export function applyConsecutiveFails(status: ProbeStatus, priorFailures: number): FailureTransition {
  switch (status) {
    case 'operational':
      return { status: 'operational', consecutiveFailures: 0, spark: 'ok' };
    case 'down': {
      const consecutiveFailures = priorFailures + 1;
      return {
        status: consecutiveFailures >= DOWN_THRESHOLD ? 'down' : 'degraded',
        consecutiveFailures,
        spark: 'fail',
      };
    }
    case 'degraded':
      return { status: 'degraded', consecutiveFailures: priorFailures + 1, spark: 'slow' };
    case 'unknown':
    default:
      return { status: 'unknown', consecutiveFailures: priorFailures, spark: null };
  }
}

/** Push a sparkline sample to the front, newest first, capped to `cap`. */
export function nextHistogram(histogram: SparkSample[], spark: SparkSample, cap = 60): SparkSample[] {
  if (spark === null) return histogram;
  return [spark, ...histogram].slice(0, cap);
}

/** Percentage of successful samples, rounded to 2 decimals, or null if empty. */
export function computeUptime(operational: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((operational / total) * 10000) / 100;
}

export interface AvailabilitySample {
  checked_at: number;
  status: string;
}

export interface AvailabilityBucket {
  start: number;
  end: number;
  uptime: number;
  sampleCount: number;
}

/**
 * Group samples within the trailing window into fixed-size buckets, newest
 * bucket last. Samples older than `windowMs` are ignored.
 */
export function bucketAvailability(
  samples: AvailabilitySample[],
  bucketMs: number,
  windowMs: number,
  now: number,
): AvailabilityBucket[] {
  const windowStart = now - windowMs;
  const buckets = new Map<number, { up: number; total: number }>();

  for (const sample of samples) {
    if (sample.checked_at < windowStart || sample.checked_at > now) continue;
    const index = Math.floor((now - sample.checked_at) / bucketMs);
    const bucket = buckets.get(index) ?? { up: 0, total: 0 };
    bucket.total += 1;
    if (sample.status === 'operational') bucket.up += 1;
    buckets.set(index, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([index, bucket]) => ({
      start: now - (index + 1) * bucketMs,
      end: now - index * bucketMs,
      uptime: computeUptime(bucket.up, bucket.total) ?? 0,
      sampleCount: bucket.total,
    }));
}
