// The ZIP player iframe is built from SANDBOX_ORIGIN, so its CSP frame-src
// must come from the same binding. A hard-coded production origin blocks the
// iframe in local/test deployments that use http://localhost:3000.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../functions/api/ogp-player/[id].ts';

type Env = Parameters<typeof onRequest>[0]['env'];

function zipPlayer(sandboxOrigin?: string): Promise<Response> {
  const env = {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ payload_key: 'payload.zip', swf_key: null }) }) }),
    },
    ...(sandboxOrigin === undefined ? {} : { SANDBOX_ORIGIN: sandboxOrigin }),
  } as unknown as Env;
  return onRequest({
    request: new Request('https://flaxia.app/api/ogp-player/game-1'),
    env,
    params: { id: 'game-1' },
  });
}

test('ZIP player CSP frame-src follows SANDBOX_ORIGIN', async () => {
  const response = await zipPlayer('http://localhost:3000');
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-src\s+http:\/\/localhost:3000(?:[\s;]|$)/);
  assert.doesNotMatch(csp, /frame-src\s+https:\/\/sandbox\.flaxia\.app(?:[\s;]|$)/);
  // The rest of the policy must stay intact.
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'self'/);

  const html = await response.text();
  assert.match(html, /<iframe src="http:\/\/localhost:3000\/api\/wvfs-zip\/game-1\?runtime=2"/);
  assert.doesNotMatch(html, /<iframe src="https:\/\/sandbox\.flaxia\.app/);
});

test('ZIP player CSP falls back to the production sandbox when SANDBOX_ORIGIN is unset', async () => {
  const response = await zipPlayer();
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /frame-src\s+https:\/\/sandbox\.flaxia\.app(?:[\s;]|$)/,
  );
});
