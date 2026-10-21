// Full-stack session regression tests for the link-preview endpoint.
// CI starts Wrangler's test server before running the test suite.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

const endpoint = (url?: string) =>
  BASE_URL + '/api/link-preview' + (url === undefined ? '' : '?url=' + encodeURIComponent(url));

describe('GET /api/link-preview: real session enforcement', () => {
  beforeEach(resetDb);

  it('requires authentication even before checking missing or forbidden URLs', async () => {
    for (const url of [undefined, 'https://example.com/', 'http://127.0.0.1/secret']) {
      const response = await fetch(endpoint(url));
      assert.equal(response.status, 401, String(url));
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    }
  });

  it('does not accept arbitrary or unknown session cookies', async () => {
    const response = await fetch(endpoint('https://example.com/'), {
      headers: { Cookie: 'session=not-a-real-session' },
    });
    assert.equal(response.status, 401);
  });

  it('accepts a real session and reaches validation without remote network access', async () => {
    const { cookie } = await seedUserAndLogin('linkpreview');
    const missing = await fetch(endpoint(), { headers: { Cookie: cookie } });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: 'Missing url parameter' });

    for (const url of ['http://127.0.0.1/private', 'http://[::ffff:127.0.0.1]/private', 'file:///etc/passwd']) {
      const response = await fetch(endpoint(url), { headers: { Cookie: cookie } });
      assert.equal(response.status, 400, url);
    }
  });

  it('rejects a previously valid session immediately after logout', async () => {
    const { cookie } = await seedUserAndLogin('linkpreviewlogout');
    const before = await fetch(endpoint(), { headers: { Cookie: cookie } });
    assert.equal(before.status, 400, 'a valid session must get past requireAuth');

    const logout = await fetch(BASE_URL + '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(logout.status, 200);

    // Reuse the old cookie explicitly, bypassing the browser's Set-Cookie clearing.
    const after = await fetch(endpoint('https://example.com/'), { headers: { Cookie: cookie } });
    assert.equal(after.status, 401);
  });
});
