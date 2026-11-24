// Profile route + redirect guards.
//
// `_redirects` must never rewrite `/users/:username` to the JSON API: that URL
// is a SvelteKit page. Parameterised ActivityPub redirects (`/actors/:name`,
// `/notes/:id`, `/users/:name/inbox`) moved into `src/hooks.server.ts` because
// adapter-cloudflare cannot express `/:param` rules in `_routes.json`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { legacyRedirect } from '../src/hooks.server.ts';

const REDIRECTS_URL = new URL('../_redirects', import.meta.url);
const HOOKS_URL = new URL('../src/hooks.server.ts', import.meta.url);

/** Rule lines of _redirects as [from, to, status]; comments and blanks removed. */
function rules(source: string): string[][] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\s+/));
}

test('/users/:username is not redirected to the JSON API', async () => {
  const source = await readFile(REDIRECTS_URL, 'utf8');
  const apiRules = rules(source).filter(
    ([from, to]) => from.startsWith('/users/') && to.startsWith('/api/users/') && !to.endsWith('/inbox'),
  );
  assert.deepEqual(apiRules, [], 'profile URLs must never be rewritten to the raw JSON API');
  assert.equal(legacyRedirect('/users/alice'), null, '/users/:username is a SvelteKit page, not a redirect');
});

test('the ActivityPub inbox redirect is preserved in the handle hook', async () => {
  assert.deepEqual(legacyRedirect('/users/alice/inbox'), { location: '/api/actors/alice/inbox', status: 308 });
  const source = await readFile(HOOKS_URL, 'utf8');
  assert.match(source, /users/);
  assert.match(source, /inbox/);
  assert.match(source, /308/);
});

test('_redirects keeps only static rules the adapter can exclude', async () => {
  const source = await readFile(REDIRECTS_URL, 'utf8');
  for (const [from] of rules(source)) {
    assert.doesNotMatch(from, /\/:/, `${from} must move to hooks.server.ts (adapter-cloudflare rejects :params)`);
  }
  const byFrom = new Map(rules(source).map((rule) => [rule[0], rule]));
  assert.deepEqual(byFrom.get('/'), ['/', '/home', '301']);
  assert.deepEqual(byFrom.get('/whitepaper'), ['/whitepaper', '/docs/whitepaper', '308']);
});

test('ActivityPub discovery is served by SvelteKit routes, not redirects', async () => {
  const source = await readFile(REDIRECTS_URL, 'utf8');
  const byFrom = new Map(rules(source).map((rule) => [rule[0], rule]));
  for (const from of ['/.well-known/webfinger', '/.well-known/nodeinfo', '/host-meta', '/sitemap.xml']) {
    assert.equal(byFrom.has(from), false, `${from} must be handled by +server.ts, not _redirects`);
  }
});
