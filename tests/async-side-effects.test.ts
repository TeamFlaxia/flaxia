import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Blank out comments and string literals while preserving character offsets. */
function blankNonCode(src: string): string {
  const chars = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < chars.length; j += 1) if (chars[j] !== '\n') chars[j] = ' ';
  };
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
    } else {
      i += 1;
    }
  }
  return chars.join('');
}

/**
 * Source-inspection helper: find every `<name>(...)` call and return the
 * balanced argument region. Used to verify that side-effect calls live inside
 * a waitUntil() callback rather than on the request's critical path.
 */
function callRegions(src: string, name: string): Array<{ start: number; end: number; body: string }> {
  const code = blankNonCode(src);
  const needle = `${name}(`;
  const regions: Array<{ start: number; end: number; body: string }> = [];
  let cursor = 0;
  while (cursor < src.length) {
    const start = code.indexOf(needle, cursor);
    if (start === -1) break;
    let depth = 1;
    let i = start + needle.length;
    let quote = '';
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = '';
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        i = src.indexOf('\n', i);
        if (i === -1) break;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      i += 1;
    }
    regions.push({ start, end: i, body: src.slice(start, i) });
    cursor = i;
  }
  return regions;
}

function mask(src: string, regions: Array<{ start: number; end: number }>): string {
  const chars = src.split('');
  for (const { start, end } of regions) {
    for (let i = start; i < end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

const SIDE_EFFECT = /\b(?:sendPushToAll|deliverToActorInbox|deliverToFollowers)\s*\(/;
const AWAITED_SIDE_EFFECT =
  /\bawait\s+(?:sendPushToAll|deliverToActorInbox|deliverToFollowers|deliverReloadActivity)\s*\(/;

function assertAsyncSideEffects(paths: string | string[], minSchedules: number): void {
  const labels = Array.isArray(paths) ? paths : [paths];
  // A route and its extracted helper module are checked together: scheduling
  // may live in either file, but nothing may run on the request critical path.
  const src = labels.map(source).join('\n');
  const label = labels.join(' + ');
  const schedules = callRegions(src, 'waitUntil');
  assert.ok(schedules.length >= minSchedules, `${label}: expected >= ${minSchedules} waitUntil schedules`);
  // Everything outside the scheduled callbacks must be free of push/federation
  // calls, in particular inline `await`s on the request's critical path.
  const criticalPath = mask(src, schedules);
  assert.ok(!AWAITED_SIDE_EFFECT.test(criticalPath), `${label}: push/federation must not be awaited inline`);
  assert.ok(!SIDE_EFFECT.test(criticalPath), `${label}: push/federation calls must be scheduled via waitUntil`);
}

describe('async side effects stay off the click critical path', () => {
  it('engagement schedules fresh/reload push and federation after the JSON response', () => {
    assertAsyncSideEffects(
      ['../functions/api/routes/posts/engagement.ts', '../functions/api/routes/posts/engagement-federation.ts'],
      4,
    );
  });

  it('composer schedules publish mention/quote push and federation after the JSON response', () => {
    assertAsyncSideEffects('../functions/api/routes/posts/composer.ts', 3);
  });

  it('the waitUntil scheduler uses the Cloudflare ExecutionContext', () => {
    // The scheduler lives in a dependency-free module so it can be unit-tested
    // under plain Node; notify.ts re-exports it for the API handlers.
    assert.match(
      source('../functions/lib/background-task.ts'),
      /executionCtx[^\n]*waitUntil\s*\(|waitUntil\s*\([^)]*promise/i,
    );
    assert.match(source('../functions/lib/notify.ts'), /export \{ waitUntil \}/);
  });

  it('Web Push outbound fetches are bounded by AbortSignal.timeout()', () => {
    const src = source('../functions/lib/push.ts');
    const fetches = callRegions(src, 'fetch');
    assert.ok(fetches.length >= 1, 'push.ts must contain a Web Push fetch');
    for (const region of fetches) {
      assert.match(
        region.body,
        /signal\s*:\s*AbortSignal\.timeout\(\s*\d[\d_]*\s*\)/,
        'every Web Push fetch must have a bounded AbortSignal.timeout()',
      );
    }
  });

  it('FCM token and send fetches are bounded by AbortSignal.timeout()', () => {
    const src = source('../functions/lib/fcm.ts');
    const fetches = callRegions(src, 'fetch');
    assert.ok(fetches.length >= 2, 'fcm.ts must contain token exchange and message send fetches');
    for (const region of fetches) {
      assert.match(
        region.body,
        /signal\s*:\s*AbortSignal\.timeout\(\s*\d[\d_]*\s*\)/,
        'every FCM fetch must have a bounded AbortSignal.timeout()',
      );
    }
  });

  it('ActivityPub direct delivery is bounded and fan-out is not serial', () => {
    const src = source('../functions/lib/activitypub/delivery.ts');
    const fetches = callRegions(src, 'fetch');
    assert.ok(fetches.length >= 1);
    for (const region of fetches) {
      assert.match(region.body, /signal\s*:\s*AbortSignal\.timeout\(\s*\d[\d_]*\s*\)/);
    }
    assert.match(src, /Promise\.allSettled\s*\(/, 'inbox fan-out should not await inboxes one by one');
  });
});
