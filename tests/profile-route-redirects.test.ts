// Profile route + redirect guards.
//
// `public/_redirects` used to contain `/users/:splat /api/users/:splat 308`.
// That rule shadowed the SPA fallback: `functions/users/[username].ts` calls
// `context.next()` for non-crawler browsers so the SPA can render the profile,
// and `next()` then hit the redirect, so a browser opening /users/:username got
// a 308 to the raw JSON API instead of the profile page. The rule is gone;
// these assertions pin the redirect table and the function's fallthrough so it
// cannot come back silently. Static-file assertions are enough here: the
// function module uses extensionless imports, so importing it from node:test
// is not practical.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const REDIRECTS_URL = new URL('../public/_redirects', import.meta.url);
const PROFILE_FUNCTION_URL = new URL('../functions/users/[username].ts', import.meta.url);

/** Rule lines of public/_redirects as [from, to, status]; comments and blanks removed. */
function rules(source: string): string[][] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\s+/));
}

test('/users/:username is not redirected to the JSON API', async () => {
  const source = await readFile(REDIRECTS_URL, 'utf8');
  const profileRules = rules(source).filter(([from]) => from === '/users/:splat');
  assert.deepEqual(
    profileRules,
    [],
    '/users/:username must fall through to the SPA (browsers) / SSR function (crawlers), not redirect to /api/users/*',
  );

  const apiRules = rules(source).filter(
    ([from, to]) => from.startsWith('/users/') && to.startsWith('/api/users/') && !to.endsWith('/inbox'),
  );
  assert.deepEqual(apiRules, [], 'profile URLs must never be rewritten to the raw JSON API');
});

test('the ActivityPub inbox redirect is preserved', async () => {
  const source = await readFile(REDIRECTS_URL, 'utf8');
  const inbox = rules(source).filter(([from]) => from === '/users/:username/inbox');
  assert.equal(inbox.length, 1, 'expected exactly one /users/:username/inbox rule');
  const rule = inbox[0];
  assert.ok(rule, 'inbox rule must exist');
  assert.equal(rule[1], '/api/users/:username/inbox');
  assert.equal(rule[2], '308');
});

test('public/_redirects documents why the profile route is not redirected', async () => {
  const source = await readFile(REDIRECTS_URL, 'utf8');
  assert.match(
    source,
    /^#[^\n]*\/users\/:username[^\n]*SPA/m,
    'keep a comment next to the rules explaining that /users/:username is served by the SPA for browsers',
  );
});

test('the profile function still hands non-crawler browsers to the SPA', async () => {
  const source = await readFile(PROFILE_FUNCTION_URL, 'utf8');
  assert.match(source, /if \(!isCrawler\(userAgent\)\)/);
  assert.match(source, /return await context\.next\(\);/);
});
