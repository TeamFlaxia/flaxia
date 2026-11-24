// SSR parity: the first HTML response must contain real content, independent
// of User-Agent. This is the regression guard for the removed crawler shim.
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

describe('SvelteKit SSR', () => {
  beforeEach(resetDb);

  it('renders posts, threads and profiles for clients without JavaScript', async () => {
    const { cookie, username } = await seedUserAndLogin('ssr');
    const postId = crypto.randomUUID();
    const text = `server rendered ${crypto.randomUUID().slice(0, 8)}`;
    const created = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, text, hashtags: [] }),
    });
    assert.equal(created.status, 200);

    const home = await fetch(`${BASE_URL}/home`);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /class="ssr-post/);
    assert.ok(homeHtml.includes(text), 'home HTML must contain the post text');
    assert.doesNotMatch(homeHtml, /id="initial-loader"/, 'SSR must not hide content behind a spinner');
    assert.match(home.headers.get('content-security-policy') ?? '', /'sha256-/);

    const thread = await fetch(`${BASE_URL}/thread/${postId}`);
    assert.equal(thread.status, 200);
    assert.ok((await thread.text()).includes(text), 'thread HTML must contain the root post');

    const profile = await fetch(`${BASE_URL}/users/${username}`);
    assert.equal(profile.status, 200);
    const profileHtml = await profile.text();
    assert.ok(profileHtml.includes(text), 'profile HTML must contain the user posts');
    assert.match(profileHtml, /ssr-profile/);
  });

  it('does not vary content by User-Agent (no crawler gate)', async () => {
    const { cookie } = await seedUserAndLogin('ssrbot');
    const postId = crypto.randomUUID();
    const text = `bot parity ${crypto.randomUUID().slice(0, 8)}`;
    await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, text, hashtags: [] }),
    });

    const browser = await (await fetch(`${BASE_URL}/home`)).text();
    const bot = await (
      await fetch(`${BASE_URL}/home`, { headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } })
    ).text();
    assert.ok(browser.includes(text));
    assert.ok(bot.includes(text), 'crawler UA must receive the same SSR document');
    assert.doesNotMatch(browser, /isCrawler/);
  });

  it('returns 404 for unknown threads and profiles', async () => {
    const thread = await fetch(`${BASE_URL}/thread/${crypto.randomUUID()}`);
    assert.equal(thread.status, 404);
    const profile = await fetch(`${BASE_URL}/users/does-not-exist-${crypto.randomUUID().slice(0, 6)}`);
    assert.equal(profile.status, 404);
  });
});
