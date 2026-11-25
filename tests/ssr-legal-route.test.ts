// `/legal` is redirected to `/privacy` by the edge `_redirects` file in
// production, but plain `vite dev` has no _redirects and used to fall into the
// catch-all 404. A universal load makes the two environments behave the same.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const SSR_URL = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('/legal has a universal load that redirects to /privacy', async () => {
  const source = await read('src/routes/legal/+page.ts');
  assert.match(source, /from ['"]@sveltejs\/kit['"]/, 'the redirect must come from SvelteKit');
  assert.match(source, /export (?:const|function) load\b/, 'the route must export a universal load');
  assert.match(
    source,
    /redirect\(\s*308\s*,\s*['"]\/privacy['"]\s*\)/,
    'the load must issue a permanent redirect to /privacy',
  );
  assert.doesNotMatch(source, /onMount|window\./, 'the redirect must not depend on the browser');
});

test('production _redirects still owns the /legal edge redirect', async () => {
  const redirects = await read('_redirects');
  assert.match(redirects, /\/legal\s+\/privacy\s+308/, 'the edge redirect must remain unchanged');
});

test('GET /legal responds with a 3xx redirect to /privacy', async (t) => {
  let response: Response;
  try {
    response = await fetch(new URL('/legal', SSR_URL), {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    t.skip(`SSR server is not reachable at ${SSR_URL}: ${String(error)}`);
    return;
  }
  assert.ok(response.status >= 300 && response.status < 400, `expected a 3xx redirect, got ${response.status}`);
  const location = response.headers.get('location');
  assert.ok(location, 'a redirect must carry a Location header');
  assert.equal(new URL(location, SSR_URL).pathname, '/privacy');
});
