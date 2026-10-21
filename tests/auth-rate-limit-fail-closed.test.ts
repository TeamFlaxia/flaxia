import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      )
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      throw error;
    }
  },
});
const { default: auth } = await import('../functions/api/routes/auth.ts');
for (const [environment, address, local] of [
  ['test', 'http://localhost:8788', true],
  ['development', 'http://127.0.0.1:8787', true],
  ['production', 'http://localhost:8788', false],
  ['test', 'https://flaxia.app', false],
  ['test', 'http://localhost.attacker.example', false],
] as const) {
  test(`auth exemption requires both local address and environment: ${environment} ${address}`, async () => {
    const response = await auth.request(
      '/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      {
        ENVIRONMENT: environment,
        BASE_URL: address,
      },
    );
    assert.equal(response.status, local ? 400 : 503);
    if (!local) assert.equal(response.headers.get('Retry-After'), '60');
  });
}
