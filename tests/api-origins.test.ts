import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASE_URL } from './helpers/setup.ts';

describe('development API origins', () => {
  it('accepts requests from the configured Vite port', async () => {
    const response = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 400, 'an allowed origin should reach registration validation');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
  });

  it('allows preflight requests for profile edits and deletion', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await fetch(`${BASE_URL}/api/users/me`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': method },
      });
      assert.equal(response.status, 204);
      assert.ok(response.headers.get('Access-Control-Allow-Methods')?.split(',').includes(method));
    }
  });

  it('rejects mutations from the untrusted sandbox origin', async () => {
    const response = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: 'https://sandbox.flaxia.app', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });
});
