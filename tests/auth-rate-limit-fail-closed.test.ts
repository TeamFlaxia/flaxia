import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRateLimit, RateLimitUnavailableError } from '../functions/lib/rate-limit.ts';

test('auth fail-closed mode rejects absent KV bindings', async () => {
  await assert.rejects(
    checkRateLimit(undefined, 'auth:test', {
      maxRequests: 5,
      windowSeconds: 60,
      failureMode: 'closed',
    }),
    RateLimitUnavailableError,
  );
});

test('auth fail-closed mode rejects KV exceptions rather than bypassing limits', async () => {
  const kv = {
    async get() {
      throw new Error('service unavailable');
    },
  } as unknown as KVNamespace;
  await assert.rejects(
    checkRateLimit(kv, 'auth:test', {
      maxRequests: 5,
      windowSeconds: 60,
      failureMode: 'closed',
    }),
    RateLimitUnavailableError,
  );
});

test('healthy KV still returns true up to its request ceiling', async () => {
  let count = 0;
  const kv = {
    async get() {
      return count ? String(count) : null;
    },
    async put(_key: string, value: string) {
      count = Number(value);
    },
  } as unknown as KVNamespace;
  const config = { maxRequests: 2, windowSeconds: 60, failureMode: 'closed' as const };
  assert.equal(await checkRateLimit(kv, 'auth:test', config), true);
  assert.equal(await checkRateLimit(kv, 'auth:test', config), true);
  assert.equal(await checkRateLimit(kv, 'auth:test', config), false);
});
