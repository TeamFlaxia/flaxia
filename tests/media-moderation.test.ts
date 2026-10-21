import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';

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
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});
const { default: media } = await import('../functions/api/routes/media.ts');

for (const scenario of ['hidden', 'pending', 'published', 'lookup-failed'] as const) {
  test(`attachment proxy enforces moderation: ${scenario}`, async () => {
    let storageReads = 0;
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route('/api', media);
    const env = {
      CACHE: { get: async () => null, put: async () => {} },
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (!sql.includes('JOIN posts')) return null;
              if (scenario === 'lookup-failed') throw new Error('D1 unavailable');
              return {
                user_id: 'author',
                hidden: scenario === 'hidden' ? 1 : 0,
                status: scenario === 'pending' ? 'pending' : 'published',
              };
            },
          };
        },
      },
      BUCKET: {
        async get() {
          storageReads++;
          return { body: 'image bytes', httpMetadata: { contentType: 'image/png' } };
        },
      },
    } as unknown as Bindings;
    const response = await app.request('/api/images/gif/post/1.png', {}, env);
    assert.equal(response.status, scenario === 'published' ? 200 : scenario === 'lookup-failed' ? 500 : 404);
    assert.equal(storageReads, scenario === 'published' ? 1 : 0);
  });
}
