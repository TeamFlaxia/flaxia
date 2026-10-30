import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/_middleware.ts';

const maintenancePage = '<h1>メンテナンス中</h1>';

test('production shows the maintenance page for every request', async () => {
  for (const [url, method] of [
    ['https://flaxia.app/', 'GET'],
    ['https://flaxia.app/users/alice', 'GET'],
    ['https://flaxia.app/api/posts', 'POST'],
    ['https://flaxia.app/assets/main.js', 'GET'],
    ['https://flaxia.app/api/ws/notifications', 'GET'],
  ] as const) {
    const response = await onRequest({
      request: new Request(url, { method }),
      env: { ENVIRONMENT: 'production' },
      next: async () => {
        throw new Error('maintenance must not call next');
      },
    });
    const body = await response.text();
    assert.equal(response.status, 503, url);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', url);
    assert.equal(response.headers.get('cache-control'), 'no-store', url);
    assert.equal(response.headers.get('retry-after'), '3600', url);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex', url);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/, url);
    assert.ok(body.includes(maintenancePage), url);
    assert.ok(body.includes('Flaxia is currently under maintenance'), url);
  }
});

test('a missing environment fails closed to maintenance', async () => {
  const response = await onRequest({
    request: new Request('https://flaxia.app/'),
    env: {},
    next: async () => {
      throw new Error('maintenance must not call next');
    },
  });
  assert.equal(response.status, 503);
  assert.ok((await response.text()).includes(maintenancePage));
});

test('test and development environments keep the application available', async () => {
  for (const environment of ['test', 'development']) {
    const response = await onRequest({
      request: new Request('https://flaxia.app/'),
      env: { ENVIRONMENT: environment },
      next: async () => new Response('app', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    });
    assert.equal(response.status, 200, environment);
    assert.equal(await response.text(), 'app', environment);
  }
});
