// SSR parity: the first HTML response must contain real content, independent
// of User-Agent. This is the regression guard for the removed crawler shim.
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { CROWD_NODE_VERSION } from '../shared/crowd-node.ts';
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
    assert.equal(
      (browser.match(/<title>/g) ?? []).length,
      (bot.match(/<title>/g) ?? []).length,
      'UA must not change the document structure',
    );
  });

  it('returns 404 for unknown threads and profiles', async () => {
    const thread = await fetch(`${BASE_URL}/thread/${crypto.randomUUID()}`);
    assert.equal(thread.status, 404);
    const profile = await fetch(`${BASE_URL}/users/does-not-exist-${crypto.randomUUID().slice(0, 6)}`);
    assert.equal(profile.status, 404);
  });

  it('serves postbuild-generated static files as files, not SPA HTML', async () => {
    const crowd = await fetch(`${BASE_URL}/crowd/v${CROWD_NODE_VERSION}-0/index.js`);
    assert.equal(crowd.status, 200);
    assert.match(crowd.headers.get('content-type') ?? '', /javascript/);
    assert.match(await crowd.text(), /export|import/i, 'Crowd node entry must be a JS module');

    const docs = await fetch(`${BASE_URL}/docs/index.json`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get('content-type') ?? '', /json/);
    assert.ok(Array.isArray(((await docs.json()) as { docs?: unknown[] }).docs));

    const popup = await fetch(`${BASE_URL}/export-popup.html`);
    assert.equal(popup.status, 200);
    assert.match(await popup.text(), /Flaxia — Export/, 'the export popup must not be the SPA shell');
  });

  it('emits a CSP that allows the webfont hosts', async () => {
    const response = await fetch(`${BASE_URL}/home`);
    const csp = response.headers.get('content-security-policy') ?? '';
    const fontSrc = /font-src ([^;]+)/.exec(csp)?.[1] ?? '';
    assert.match(fontSrc, /'self'/, 'font-src must be declared explicitly');
    assert.match(fontSrc, /https:\/\/fonts\.gstatic\.com/, 'Noto Sans woff2 files must load');
    assert.match(fontSrc, /https:\/\/cdn\.jsdelivr\.net/);
  });

  it('emits exactly one title per document', async () => {
    for (const path of ['/home', '/thread/x']) {
      const html = await (await fetch(`${BASE_URL}${path}`)).text();
      assert.equal((html.match(/<title>/g) ?? []).length, 1, `${path} must not duplicate <title>`);
    }
  });

  it('does not 500 on a malformed locale cookie', async () => {
    const response = await fetch(`${BASE_URL}/home`, { headers: { Cookie: 'flaxia_locale=%' } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html lang="/);
  });
});
