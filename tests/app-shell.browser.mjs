// Real-app smoke tests.
//
// Boots the actual `vite build` output (dist/index.html + hashed assets) against
// a static file server and a stubbed /api. Two surfaces are checked:
//
//   1. the guest shell (the legacy 240/600/350 columns and flat post rows);
//   2. /settings for a signed-in user (the engine-rendered sections mount and
//      keep their inputs, selects and keyed lists).
//
// Run with:
//   npm run test:app:browser
//   APP_BROWSER=firefox npm run test:app:browser
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium, firefox, webkit } = await import(playwrightModule);
const browserName = process.env.APP_BROWSER ?? 'chromium';
const engine = { chromium, firefox, webkit }[browserName];
assert.ok(engine, `unknown APP_BROWSER: ${browserName}`);

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
// Vite emitted dist/assets/*; the SvelteKit shell emits dist/_app/immutable/*.
let hasBuiltCss = false;
for (const dir of [join(distDir, 'assets'), join(distDir, '_app/immutable/assets')]) {
  try {
    const assets = await readdir(dir);
    if (assets.some((file) => file.endsWith('.css'))) hasBuiltCss = true;
  } catch {
    // This build layout is not the one in use.
  }
}
assert.ok(hasBuiltCss, 'vite build must produce dist CSS assets before this test');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const TIMELINE_POST = {
  id: 'p1',
  user_id: 'u2',
  username: 'author',
  display_name: 'Author',
  text: 'Hello @quoted and #flaxia from the built app smoke test.',
  hashtags: 'flaxia',
  mentions: JSON.stringify([{ username: 'quoted', user_id: 'u3' }]),
  created_at: new Date(Date.now() - 60_000).toISOString(),
  fresh_count: 3,
  reply_count: 1,
  reload_count: 0,
  bookmark_count: 0,
  impressions: 42,
  depth: 0,
  quoted_post_id: 'q1',
  quoted_post: {
    id: 'q1',
    user_id: 'u3',
    username: 'quoted',
    display_name: 'Quoted',
    text: 'An older quoted post.',
    hashtags: '',
    created_at: new Date(Date.now() - 120_000).toISOString(),
  },
  reactions: [
    { emoji: '💚', count: 2, reacted: false },
    { emoji: '🎉', count: 1, reacted: true },
  ],
};

const TIMELINE_RESPONSE = { body: { posts: [TIMELINE_POST], nextCursor: null } };

// A post whose image arrives late: the reserved 16:9 box must absorb it.
const MEDIA_POST = {
  ...TIMELINE_POST,
  id: 'p2',
  text: 'Media post for the layout-shift budget.',
  mentions: '',
  hashtags: '',
  quoted_post_id: undefined,
  quoted_post: undefined,
  reactions: [],
  attachments: [{ r2_key: 'smoke.png', kind: 'image', position: 1 }],
};

const GUEST_STUBS = {
  '/api/me': { status: 401, body: {} },
  '/api/posts': TIMELINE_RESPONSE,
  '/api/posts/recommended': TIMELINE_RESPONSE,
  '/api/trending': { body: { tags: [] } },
  '/api/users/suggested': { body: { users: [] } },
  '/api/ads': { body: { ads: [] } },
  '/api/ads/active': { body: { ads: [] } },
  '/api/tags/trending': { body: { tags: [] } },
  '/api/users/suggestions': { body: { users: [] } },
  '/api/search': {
    body: { results: [{ username: 'quoted', display_name: 'Quoted', avatar_key: null }] },
  },
  '/api/tags/suggest': { body: { tags: [{ tag: 'flaxia', count: 12 }] } },
  '/api/games': { body: { games: [], next_cursor: null } },
};

// Same stubs, but the feed is one post whose image arrives late.
const MEDIA_STUBS = {
  ...GUEST_STUBS,
  '/api/posts': { body: { posts: [MEDIA_POST], nextCursor: null } },
  '/api/posts/recommended': { body: { posts: [MEDIA_POST], nextCursor: null } },
};

// Async right-rail payloads: trending tags, a weather forecast and follow
// suggestions all land after first paint.
const BUSY_STUBS = {
  ...MEDIA_STUBS,
  '/api/tags/trending': {
    body: {
      tags: [
        { tag: 'flaxia', count: 120, percentage: 42 },
        { tag: 'indiegame', count: 80, percentage: 30 },
        { tag: 'pixelart', count: 55, percentage: 18 },
        { tag: 'webgl', count: 31, percentage: 10 },
      ],
    },
  },
  '/api/maps/weather': {
    body: {
      lat: 35.68,
      lon: 139.65,
      points: [
        { time: '2026-11-17T09:00:00Z', temperature: 18, humidity: 55, windSpeed: 3, symbol: 'partlycloudy_day' },
        { time: '2026-11-17T15:00:00Z', temperature: 20, humidity: 48, windSpeed: 2, symbol: 'clearsky_day' },
      ],
    },
  },
  '/api/users/suggestions': {
    body: { users: [{ username: 'quoted', display_name: 'Quoted', avatar_key: null }] },
  },
};

const OWN_POST = {
  ...TIMELINE_POST,
  id: 'own-post-1',
  user_id: 'u1',
  username: 'mikan',
  display_name: 'Mikan',
  text: 'original text',
  hashtags: '',
  quoted_post_id: null,
  quoted_post: null,
};

const AD_POSTS = Array.from({ length: 8 }, (_, index) => ({ ...MEDIA_POST, id: `ad-post-${index}` }));
const AD_STUBS = {
  ...MEDIA_STUBS,
  '/api/posts': { body: { posts: AD_POSTS, nextCursor: null } },
  '/api/posts/recommended': { body: { posts: AD_POSTS, nextCursor: null } },
  '/api/ads/active': {
    body: {
      ads: [
        {
          id: 'ad-test-1',
          title: 'Test ad',
          body_text: 'Sponsored test',
          ad_type: 'self_hosted',
          payload_type: 'image',
          payload_key: 'ad/payload/test',
          thumbnail_key: null,
          click_url: 'https://example.com/ad',
          impressions: 1,
          clicks: 0,
          active: 1,
          created_at: '2026-11-22T00:00:00.000Z',
        },
      ],
    },
  },
};

const SIGNED_IN_STUBS = {
  ...GUEST_STUBS,
  '/api/me': {
    body: { user: { id: 'u1', username: 'mikan', display_name: 'Mikan', language: 'en' } },
  },
  '/api/auth/recovery/status': { status: 404, body: {} },
  '/api/titles/me': { body: { titles: [{ id: 't1', icon: 'star', name: 'Pioneer', description: 'Joined early' }] } },
  '/api/stamps': { body: { stamps: [] } },
  '/api/billing/plan': {
    body: { plan: 'flaxia_plus', status: 'active', expiresAt: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false },
  },
  '/api/billing/transactions': {
    body: {
      transactions: [
        { createdAt: '2026-11-01T00:00:00Z', planName: 'Flaxia+', amount: 300, currency: 'jpy', status: 'paid' },
      ],
    },
  },
};

const EDIT_STUBS = {
  ...SIGNED_IN_STUBS,
  '/api/me': { body: { user: { id: 'u1', username: 'mikan', display_name: 'Mikan', language: 'en' } } },
  '/api/posts': { body: { posts: [OWN_POST], nextCursor: null } },
  '/api/posts/recommended': { body: { posts: [OWN_POST], nextCursor: null } },
  '/api/posts/own-post-1': { body: { post: { ...OWN_POST, text: 'edited text' } } },
};

const REPLY_TREE_ROOT = {
  ...TIMELINE_POST,
  id: 'thread-root',
  text: 'Thread root for the reply tree smoke test.',
  hashtags: '',
  mentions: '[]',
  quoted_post_id: null,
  quoted_post: null,
  reactions: [],
  depth: 0,
  reply_count: 2,
};

const REPLY_TREE_PARENT = {
  ...REPLY_TREE_ROOT,
  id: 'reply-1',
  username: 'replier',
  display_name: 'Replier',
  text: 'First reply',
  parent_id: 'thread-root',
  root_id: 'thread-root',
  depth: 1,
  reply_count: 1,
};

const REPLY_TREE_CHILD = {
  ...REPLY_TREE_ROOT,
  id: 'reply-2',
  username: 'nested',
  display_name: 'Nested',
  text: 'Nested reply',
  parent_id: 'reply-1',
  root_id: 'thread-root',
  depth: 2,
  reply_count: 0,
};

// The thread page renders ReplyNode.svelte when the Twitter-style reply tree is
// selected; the default 2ch setting flattens replies through PostCard.
const REPLY_TREE_STUBS = {
  ...SIGNED_IN_STUBS,
  '/api/posts/thread-root/thread': {
    body: { root: REPLY_TREE_ROOT, replies: [REPLY_TREE_PARENT, REPLY_TREE_CHILD] },
  },
  '/api/posts/thread-root': { body: { post: REPLY_TREE_ROOT } },
};

const ZIP_POST = {
  ...TIMELINE_POST,
  id: 'zip-post',
  user_id: 'u1',
  username: 'mikan',
  display_name: 'Mikan',
  text: 'A ZIP game that asks the host page for an online room.',
  hashtags: '',
  mentions: '[]',
  payload_key: 'versions/zip-post/game.zip',
  gif_key: null,
  swf_key: null,
  quoted_post_id: null,
  quoted_post: null,
  game_description: 'ZIP test game',
};

const ZIP_STUBS = {
  ...SIGNED_IN_STUBS,
  '/api/posts/zip-post/thread': { body: { root: ZIP_POST, replies: [] } },
  '/api/posts/zip-post': { body: { post: ZIP_POST } },
  '/api/multiplayer/rooms': { body: { roomId: 'room-1', gameId: 'zip-game', maxPlayers: 2 } },
  '/api/multiplayer/rooms/room-1/join': {
    body: {
      success: true,
      roomId: 'room-1',
      userId: 'u1',
      wsUrl: '/api/ws/multiplayer?roomId=room-1&gameId=zip-game',
    },
  },
};

// The stubbed sandbox document behaves like a game using the Game SDK: it
// records parent messages and asks to join multiplayer on load.
const ZIP_GAME_HTML = `<!doctype html><html><body><script>
  window.__received = [];
  window.addEventListener('message', (event) => { window.__received.push(event.data); });
  setTimeout(() => {
    window.parent.postMessage({ type: 'MULTIPLAYER_CONNECT', gameId: 'zip-game' }, '*');
  }, 50);
</script></body></html>`;

// 1x1 transparent PNG: stubbed media so <img> loading is exercised locally.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Performance observers installed before any app script runs. Layout shifts
// without recent input count toward CLS; LCP is recorded for the budget check.
const PERFORMANCE_INIT_SCRIPT = () => {
  const perf = { cls: 0, lcp: 0, shifts: [] };
  window.__flaxiaPerf = perf;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      perf.cls += entry.value;
      if (entry.value > 0) {
        perf.shifts.push({
          value: entry.value,
          sources: (entry.sources || []).map((source) => ({
            node: source.node?.className || source.node?.nodeName || '',
            previous: source.previousRect ? source.previousRect.y : null,
            current: source.currentRect ? source.currentRect.y : null,
          })),
        });
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.lcp = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
};

function createStaticServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requested = join(distDir, decodeURIComponent(url.pathname));

    let filePath = requested;
    try {
      const info = await stat(requested);
      if (info.isDirectory()) filePath = join(requested, 'index.html');
    } catch {
      // Unknown paths fall back to the SPA entry so the router can handle them.
      filePath = join(distDir, 'index.html');
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

async function launchBrowser() {
  try {
    return await engine.launch(browserName === 'chromium' ? { channel: 'chrome' } : {});
  } catch {
    return await engine.launch();
  }
}

/**
 * Boots one page against the built app.
 *
 * Third-party requests (fonts, AdSense, the crowd node bundle) are aborted: the
 * app must render without them.
 */
async function openApp(browser, url, stubs, viewport = { width: 1400, height: 1000 }, options = {}) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  if (options.measurePerformance) {
    await page.addInitScript(PERFORMANCE_INIT_SCRIPT);
  }

  // One handler for every request: WebKit does not consistently apply two
  // overlapping route globs in the same order as Chromium, so /api requests
  // could fall through to the static server and receive index.html as JSON.
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname === 'sandbox.flaxia.app' && options.sandboxHtml) {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: options.sandboxHtml(requestUrl),
      });
    }
    if (requestUrl.hostname !== '127.0.0.1') return route.abort();
    // WebSocket upgrades are handled by page.routeWebSocket, not the JSON stub.
    if (requestUrl.pathname.startsWith('/api/ws/')) return route.continue();

    if (requestUrl.pathname.startsWith('/api/')) {
      // Media goes through /api/images/*; answer with a real PNG (optionally
      // delayed) so late image loads are measured against the reserved box.
      if (requestUrl.pathname.startsWith('/api/images/')) {
        if (options.imageDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.imageDelayMs));
        }
        return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
      }
      const stub = stubs[requestUrl.pathname];
      return route.fulfill({
        status: stub?.status ?? 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(stub?.body ?? {}),
      });
    }

    return route.continue();
  });

  await page.goto(url, { waitUntil: 'load' });
  return { page, pageErrors };
}

async function withServer(run) {
  const server = createStaticServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const browser = await launchBrowser();
  try {
    await run({ browser, origin: `http://127.0.0.1:${address.port}` });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the built app boots into the three-column shell', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, GUEST_STUBS);

    await page.waitForSelector('.main-container', { timeout: 30_000 });
    await page.waitForSelector('#initial-loader', { state: 'detached', timeout: 15_000 });

    const result = await page.evaluate(() => {
      const measure = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, x: bounds.x };
      };

      const sheet = [...document.styleSheets].find((entry) => entry.href?.includes('/assets/'));
      const layerNames = [];
      const walk = (rules) => {
        for (const rule of Array.from(rules)) {
          if (rule.constructor.name === 'CSSLayerBlockRule') {
            layerNames.push(rule.name);
            walk(rule.cssRules);
          } else if ('cssRules' in rule) {
            walk(rule.cssRules);
          }
        }
      };
      if (sheet) walk(sheet.cssRules);

      return {
        layerBlocks: layerNames.length,
        left: measure('.left-nav'),
        center: measure('.timeline, .main-content'),
        right: measure('.right-panel'),
        appChildren: document.querySelector('#app')?.children.length ?? 0,
        viewportWidth: document.documentElement.clientWidth,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        textColor: getComputedStyle(document.body).color,
        postCard: (() => {
          const card = document.querySelector('.post-card');
          if (!card) return null;
          const cs = getComputedStyle(card);
          return { padding: cs.padding, margin: cs.margin, borderRadius: cs.borderRadius };
        })(),
        leftNavPadding: (() => {
          const nav = document.querySelector('.left-nav');
          return nav ? getComputedStyle(nav).padding : null;
        })(),
        rightPanelPadding: (() => {
          const rail = document.querySelector('.right-panel');
          return rail ? getComputedStyle(rail).paddingTop : null;
        })(),
      };
    });

    // Regression guard for the @layer experiment: layered app CSS loses to the
    // unlayered critical CSS inlined in index.html, which reverted the redesign
    // (240px nav, unpadded cards). The shipped CSS must stay unlayered.
    assert.equal(result.layerBlocks, 0, 'app CSS must not use @layer');

    // The shipped design: centred 240px nav + 600px centre + 350px rail.
    assert.ok(result.appChildren > 0, '#app was never populated');
    assert.ok(result.left, 'left nav missing');
    assert.ok(Math.abs(result.left.width - 240) < 1, `left nav width: ${result.left.width}`);
    assert.ok(result.right, 'right rail missing');
    assert.ok(Math.abs(result.right.width - 350) < 1, `right rail width: ${result.right.width}`);
    assert.ok(result.center, 'content column missing');
    assert.ok(Math.abs(result.center.width - 600) < 1, `content column width: ${result.center.width}`);
    assert.ok(
      Math.abs(result.left.width + result.center.width + result.right.width - 1190) < 1,
      'the three panes must total 240 + 600 + 350',
    );
    const rightEdge = result.right.x + result.right.width;
    assert.ok(
      Math.abs(result.left.x - (result.viewportWidth - rightEdge)) < 1,
      `shell should be centred (left x ${result.left.x}, right edge ${rightEdge})`,
    );
    assert.equal(result.leftNavPadding, '16px');
    assert.equal(result.rightPanelPadding, '16px');

    // Tokens and card chrome resolve to the legacy values.
    assert.equal(result.bodyBackground, 'rgb(255, 255, 255)');
    assert.equal(result.textColor, 'rgb(15, 23, 42)');
    assert.ok(result.postCard, 'post card missing');
    assert.equal(result.postCard.padding, '16px', `post card padding: ${result.postCard.padding}`);
    assert.equal(result.postCard.margin, '0px', `post card margin: ${result.postCard.margin}`);
    assert.equal(result.postCard.borderRadius, '0px');

    // The rail no longer carries a compose button, and the game promo is
    // guest-only.
    assert.equal(await page.$('.nav-post-button'), null, 'guest rail must not show a compose button');
    assert.ok(await page.$('.nav-promo'), 'guest rail should show the game promo');

    // The stubbed timeline post exercises PostCard's header, actions and quote.
    await page.waitForSelector('.post-card', { timeout: 20_000 });
    // Rich text is rendered on idle after the plain-text placeholder.
    await page.waitForSelector('.post-card .post-text.post-text--rich', { timeout: 20_000 });
    const post = await page.evaluate(() => ({
      username: document.querySelector('.post-card .post-username')?.textContent?.trim() ?? '',
      displayName: document.querySelector('.post-card .post-display-name')?.textContent?.trim() ?? '',
      timestamp: !!document.querySelector('.post-card .post-timestamp'),
      freshButton: !!document.querySelector('.post-card .action-button--fresh'),
      replyButton: !!document.querySelector('.post-card .action-button--reply'),
      bookmarkButton: !!document.querySelector('.post-card .action-button--bookmark'),
      impressionCount:
        document.querySelector('.post-card .action-button--impressions .action-count')?.textContent?.trim() ?? '',
      reactionChips: document.querySelectorAll('.post-card .post-reaction-chip').length,
      reactionAdd: !!document.querySelector('.post-card .post-reaction-add'),
      quotedText: document.querySelector('.post-card .quoted-post-text')?.textContent?.trim() ?? '',
      quotedAuthor: document.querySelector('.post-card .quoted-post-username')?.textContent?.trim() ?? '',
      mentionLink: document.querySelector('.post-card .post-text .mention-link')?.textContent?.trim() ?? '',
      hashtagLink: document.querySelector('.post-card .post-text .hashtag-link')?.textContent?.trim() ?? '',
      richText: !!document.querySelector('.post-card .post-text.post-text--rich'),
    }));

    assert.equal(post.username, '@author');
    assert.equal(post.displayName, 'Author');
    assert.ok(post.timestamp, 'post timestamp missing');
    assert.ok(post.freshButton && post.replyButton && post.bookmarkButton, 'action buttons missing');
    // PostCard records a local impression when the card enters the timeline.
    assert.match(post.impressionCount, /^4[23]$/);
    assert.equal(post.reactionChips, 2);
    assert.ok(post.reactionAdd, 'add-reaction button missing');
    assert.match(post.quotedText, /An older quoted post/);
    assert.equal(post.quotedAuthor, '@quoted');
    assert.ok(post.richText, 'rich post text missing');
    assert.equal(post.mentionLink, '@quoted');
    assert.equal(post.hashtagLink, '#flaxia');

    // The post menu opens as a keyed list (guest sees block + report).
    await page.click('.post-card .post-menu-button');
    await page.waitForSelector('.post-menu-dropdown', { timeout: 5_000 });
    const menu = await page.evaluate(() => ({
      items: [...document.querySelectorAll('.post-menu-dropdown .fx-menu-item')].map((item) =>
        (item.textContent ?? '').trim(),
      ),
      danger: document.querySelectorAll('.post-menu-dropdown .fx-menu-item[data-danger="true"]').length,
    }));
    assert.ok(menu.items.length >= 2, `post menu items: ${menu.items.join(', ')}`);
    assert.ok(menu.danger >= 1, 'destructive menu item lost its danger marker');
    await page.keyboard.press('Escape');

    // No horizontal overflow at desktop width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `desktop layout overflows horizontally by ${overflow}px`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });
});

test('/settings mounts the engine-rendered sections for a signed-in user', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/settings`, SIGNED_IN_STUBS);

    await page.waitForSelector('.settings-section', { timeout: 30_000 });
    // Wait for the async sections (locales, titles, billing) to settle.
    await page.waitForFunction(
      () => {
        const select = document.querySelector('.settings-section select');
        const history = [...document.querySelectorAll('.settings-section')].some((section) =>
          (section.textContent ?? '').includes('JPY'),
        );
        return !!select && select.options.length > 1 && history;
      },
      { timeout: 20_000 },
    );

    const result = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('.settings-section h2')].map((heading) =>
        (heading.textContent ?? '').trim(),
      );
      const select = document.querySelector('.settings-section select');
      const languageOptions = [...(select?.querySelectorAll('option') ?? [])].map((option) => ({
        value: option.value,
        label: (option.textContent ?? '').trim(),
      }));
      const settingsText = [...document.querySelectorAll('.settings-section')]
        .map((section) => section.textContent ?? '')
        .join(' ');

      return {
        sectionCount: document.querySelectorAll('.settings-section').length,
        headings,
        languageValue: select?.value ?? '',
        languageOptions,
        emailInputs: [
          '#settings-email-current-password',
          '#settings-new-email',
          '#settings-password-current',
          '#settings-new-password',
          '#settings-confirm-password',
        ].filter((selector) => !!document.querySelector(selector)).length,
        switches: document.querySelectorAll('.settings-section .settings-switch').length,
        hasPlusPlan: settingsText.includes('Flaxia+'),
        hasBillingRow: settingsText.includes('JPY'),
        crowdStatus: (() => {
          const crowd = [...document.querySelectorAll('.settings-section')].find((section) =>
            (section.textContent ?? '').includes('Crowd'),
          );
          return crowd?.querySelector('[role="status"], .settings-status')?.textContent?.trim() ?? '';
        })(),
      };
    });

    const settingsPane = await page.evaluate(() => {
      const pane = document.querySelector('.settings-two-pane');
      const nav = document.querySelector('.settings-nav');
      return {
        columns: getComputedStyle(pane).gridTemplateColumns.split(' ').filter(Boolean).length,
        navDirection: nav ? getComputedStyle(nav).flexDirection : '',
      };
    });
    assert.equal(settingsPane.columns, 1, 'the 600px settings page must stack its panes');
    assert.equal(settingsPane.navDirection, 'row', 'the narrow settings rail must be horizontal');

    assert.ok(result.sectionCount >= 8, `expected the settings panels, found ${result.sectionCount}`);
    assert.deepEqual(
      result.headings.filter((heading, index) => result.headings.indexOf(heading) !== index),
      [],
      `duplicate section headings: ${result.headings.join(', ')}`,
    );

    // Language section: fetched locales render through the keyed list.
    assert.ok(result.languageOptions.length >= 2, `language options: ${result.languageOptions.length}`);
    assert.ok(result.languageValue, 'language select has no value');
    assert.ok(
      result.languageOptions.some((option) => option.value === result.languageValue),
      `language value ${result.languageValue} is not one of the options`,
    );

    // Email + password forms kept all five inputs and their ids.
    assert.equal(result.emailInputs, 5, 'email/password inputs missing');

    // NSFW, data saver and Crowd switches.
    assert.ok(result.switches >= 3, `expected at least 3 switches, found ${result.switches}`);

    // Billing plan card and its keyed transaction row.
    assert.ok(result.hasPlusPlan, 'Flaxia+ plan card missing');
    assert.ok(result.hasBillingRow, 'billing history row missing');
    assert.ok(result.crowdStatus.length > 0, 'crowd status text missing');

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });
});

test('the mobile viewport keeps the bottom nav and the left drawer', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const viewport = { width: 390, height: 844 };
    const { page, pageErrors } = await openApp(browser, `${origin}/`, GUEST_STUBS, viewport);

    await page.waitForSelector('.main-container', { timeout: 30_000 });
    // The bar is created by the deferred nav module after the first auth check.
    await page.waitForSelector('.bottom-nav', { timeout: 30_000 });

    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const nav = document.querySelector('.bottom-nav');
      const leftNav = document.querySelector('.left-nav');
      return {
        bottomNav: rect('.bottom-nav'),
        bottomNavDisplay: nav ? getComputedStyle(nav).display : null,
        bottomNavItems: document.querySelectorAll('.bottom-nav-item').length,
        leftNav: rect('.left-nav'),
        leftNavTransform: leftNav ? getComputedStyle(leftNav).transform : null,
        content: rect('.timeline, .main-content'),
        rightPanelDisplay: (() => {
          const panel = document.querySelector('.right-panel');
          return panel ? getComputedStyle(panel).display : null;
        })(),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    assert.ok(layout.bottomNav, 'bottom nav missing');
    assert.equal(layout.bottomNavDisplay, 'flex');
    assert.ok(layout.bottomNavItems >= 3, `bottom nav items: ${layout.bottomNavItems}`);
    assert.ok(
      Math.abs(layout.bottomNav.bottom - viewport.height) < 1,
      `bottom nav should sit on the viewport edge: ${layout.bottomNav.bottom}`,
    );
    // A classic scrollbar can shrink the fixed bar by its width; it must still
    // cover the viewport rather than collapsing to its content.
    assert.ok(
      layout.bottomNav.width >= viewport.width - 20,
      `bottom nav should span the viewport: ${layout.bottomNav.width}`,
    );

    // The left nav is an off-canvas drawer on mobile.
    assert.ok(layout.leftNav, 'left nav missing');
    assert.ok(layout.leftNav.right <= 1, `drawer should start off-canvas: right=${layout.leftNav.right}`);

    // The right rail is hidden, and nothing overflows horizontally.
    assert.equal(layout.rightPanelDisplay, 'none');
    assert.ok(layout.overflow <= 1, `mobile layout overflows by ${layout.overflow}px`);
    assert.ok(layout.content, 'content column missing');
    assert.ok(
      layout.content.width <= viewport.width + 1,
      `content column wider than the viewport: ${layout.content.width}`,
    );

    // Opening the drawer slides it in; the overlay closes it again. The slide
    // is a 300ms CSS transition, so wait for the settled position instead of
    // sampling after a fixed delay (WebKit can still be a couple of px out).
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('openLeftNav'));
    });
    await page.waitForFunction(
      () => {
        const leftNav = document.querySelector('.left-nav');
        if (!leftNav || !leftNav.classList.contains('left-nav--open')) return false;
        return Math.abs(leftNav.getBoundingClientRect().left) < 1;
      },
      { timeout: 5_000 },
    );

    const opened = await page.evaluate(() => {
      const leftNav = document.querySelector('.left-nav');
      const overlay = document.querySelector('.left-nav-overlay');
      return {
        open: leftNav?.classList.contains('left-nav--open') ?? false,
        left: leftNav?.getBoundingClientRect().left ?? -1,
        overlayVisible: overlay?.classList.contains('left-nav-overlay--visible') ?? false,
      };
    });

    assert.ok(opened.open, 'drawer did not open');
    assert.ok(Math.abs(opened.left) < 1, `drawer did not slide in: left=${opened.left}`);
    assert.ok(opened.overlayVisible, 'drawer overlay stayed hidden');

    await page.evaluate(() => {
      document.querySelector('.left-nav-overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(500);

    const closed = await page.evaluate(
      () => !(document.querySelector('.left-nav')?.classList.contains('left-nav--open') ?? false),
    );
    assert.ok(closed, 'drawer did not close from the overlay');

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });
});

test('responsive rail and drawer breakpoints stay sharp', {
  timeout: 120_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const cases = [
      // Exactly at the drawer breakpoint: bottom bar on, drawer off-canvas.
      { width: 768, height: 1024, mobile: true },
      { width: 900, height: 1024, mobile: false },
      // At the right-rail breakpoint the rail is already hidden.
      { width: 1024, height: 1024, mobile: false },
      // The rail needs nav + 600 + 350 = 1190px; just below that it is hidden.
      { width: 1100, height: 900, mobile: false },
    ];

    for (const testCase of cases) {
      const { page, pageErrors } = await openApp(browser, `${origin}/`, GUEST_STUBS, {
        width: testCase.width,
        height: testCase.height,
      });
      await page.waitForSelector('.main-container', { timeout: 30_000 });
      // The bar is mounted at every width; only its computed display differs.
      await page.waitForSelector('.bottom-nav', { state: 'attached', timeout: 30_000 });
      await page.waitForSelector('.post-card', { timeout: 30_000 });
      // Let the media query settle after the lazy nav mount.
      await page.waitForTimeout(100);

      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, width: bounds.width };
        };
        const nav = document.querySelector('.bottom-nav');
        const leftNav = document.querySelector('.left-nav');
        const rightPanel = document.querySelector('.right-panel');
        return {
          bottomNavDisplay: nav ? getComputedStyle(nav).display : null,
          leftNav: rect('.left-nav'),
          leftNavPosition: leftNav ? getComputedStyle(leftNav).position : null,
          rightPanelDisplay: rightPanel ? getComputedStyle(rightPanel).display : null,
          content: rect('.timeline, .main-content'),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });

      const label = `${testCase.width}px`;

      // The right rail is hidden below 1200px.
      assert.equal(layout.rightPanelDisplay, 'none', `${label}: right rail should be hidden`);
      assert.ok(layout.overflow <= 1, `${label}: horizontal overflow ${layout.overflow}px`);
      assert.ok(layout.content, `${label}: content column missing`);
      assert.ok(layout.content.width <= testCase.width + 1, `${label}: content wider than the viewport`);

      if (testCase.mobile) {
        assert.equal(layout.bottomNavDisplay, 'flex', `${label}: bottom nav should be visible`);
        assert.ok(layout.leftNav, `${label}: left nav missing`);
        assert.ok(layout.leftNav.right <= 1, `${label}: drawer should be off-canvas`);
      } else {
        assert.equal(layout.bottomNavDisplay, 'none', `${label}: bottom nav should be hidden`);
        assert.ok(layout.leftNav, `${label}: left nav missing`);
        // 769–1024px is the icon-only rail; above it the full 240px nav
        // returns (the rail breakpoint at 1199px is independent).
        const expectedNav = testCase.width <= 1024 ? 72 : 240;
        assert.ok(
          Math.abs(layout.leftNav.width - expectedNav) < 1,
          `${label}: nav width ${layout.leftNav.width} (expected ${expectedNav})`,
        );
        assert.ok(layout.leftNav.left >= 0, `${label}: left nav should be on-screen`);
      }

      assert.deepEqual(pageErrors, [], `${label}: page errors: ${pageErrors.join(' | ')}`);
      await page.close();
    }
  });
});

test('the Svelte mail pages render settings, compose and the locked reader', {
  timeout: 120_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const stubs = {
      ...SIGNED_IN_STUBS,
      '/api/mail/addresses': {
        body: { addresses: [{ address: 'mikan@users.flaxia.invalid', state: 'inactive' }] },
      },
      '/api/mail/quota': {
        body: {
          storage_bytes: 1048576,
          storage_quota_bytes: 10485760,
          external_sends: 2,
          daily_external_limit: 20,
        },
      },
      '/api/mail/unread': { body: 1 },
    };

    const mailboxStubs = {
      ...stubs,
      '/api/mail/addresses': { body: { addresses: [{ address: 'mikan@flaxia.app', state: 'active' }] } },
      '/api/vault/keys': {
        body: {
          enabled: true,
          salt: 's',
          recovery_salt: 'r',
          kdf_params: {},
          wrapped_vk: 'w',
          recovery_blob: 'b',
          vk_version: 1,
          devices: [],
        },
      },
    };
    const mailbox = await openApp(browser, `${origin}/mail`, mailboxStubs);
    await mailbox.page.waitForSelector('.mail-compose-button', { timeout: 30_000 });
    await mailbox.page.waitForSelector('input[type="password"]', { timeout: 10_000 });
    assert.ok(await mailbox.page.$('.mail-topbar-actions .mail-icon-button'), 'the settings button is styled');
    assert.equal(
      await mailbox.page.evaluate(
        () => getComputedStyle(document.querySelector('.mail-compose-button')).backgroundColor,
      ),
      'rgb(34, 197, 94)',
      'the compose button uses the accent button style',
    );
    assert.deepEqual(mailbox.pageErrors, []);
    await mailbox.page.close();

    const settings = await openApp(browser, `${origin}/mail/settings`, stubs);
    await settings.page.waitForSelector('.mail-settings-card', { timeout: 30_000 });
    assert.equal(await settings.page.locator('.mail-settings-card').count(), 3);
    assert.equal(await settings.page.locator('.mail-security-list li').count(), 3);
    assert.equal(await settings.page.locator('.mail-quota-bar').count(), 1);
    assert.ok(await settings.page.$('.mail-settings-vault'), 'the vault status is shown for an inactive mailbox');
    assert.deepEqual(settings.pageErrors, []);
    await settings.page.close();

    const compose = await openApp(browser, `${origin}/mail/compose`, stubs);
    await compose.page.waitForSelector('.mail-compose-card', { timeout: 30_000 });
    assert.equal(await compose.page.locator('.mail-compose-warning').isHidden(), true, 'no warning without recipients');
    await compose.page.fill('input[name="to"]', 'bob@example.com');
    await compose.page.waitForTimeout(200);
    assert.equal(await compose.page.locator('.mail-compose-warning').isHidden(), false, 'external recipients warn');
    assert.match((await compose.page.locator('.mail-compose-security .mail-chip').textContent()) ?? '', /TLS/i);
    assert.deepEqual(compose.pageErrors, []);
    await compose.page.close();

    const thread = await openApp(browser, `${origin}/mail/thread/t1`, mailboxStubs);
    await thread.page.waitForSelector('.mail-thread-page', { timeout: 30_000 });
    // MailView adopts the session in its own onMount, after this child mounts.
    // init() must wait for the prop: without it the page never reaches the
    // locked-vault state and shows the misleading "thread not found" instead.
    await thread.page.waitForSelector('#vault-unlock-form-password', { timeout: 10_000 });
    assert.ok(await thread.page.$('.mail-thread-page .mail-empty'));
    assert.deepEqual(thread.pageErrors, []);
    await thread.page.close();
  });
});

test('the left nav renders guest and signed-in states and routes its menus', {
  timeout: 120_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const stubs = {
      ...SIGNED_IN_STUBS,
      '/api/tags/trending': {
        body: {
          tags: [
            { tag: 'flaxia', count: 120, percentage: 42 },
            { tag: 'pixelart', count: 55, percentage: 18 },
          ],
        },
      },
    };

    const signed = await openApp(browser, `${origin}/explore`, stubs);
    await signed.page.waitForSelector('.left-nav .nav-item', { timeout: 30_000 });
    await signed.page.waitForSelector('.nav-tag', { state: 'attached', timeout: 10_000 });
    assert.equal(await signed.page.locator('.left-nav .nav-item').count(), 5, 'signed-in nav items');
    assert.equal(await signed.page.locator('.nav-tag').count(), 2, 'trending tags');
    assert.ok(await signed.page.$('.nav-user-area'), 'signed-in account row');
    assert.equal(await signed.page.$('.nav-auth-buttons'), null);
    assert.equal(
      await signed.page.evaluate(() =>
        document.querySelector('.nav-item[data-nav-id="explore"]')?.getAttribute('aria-current'),
      ),
      'page',
      'the current section is marked active',
    );

    await signed.page.click('.nav-user-area');
    assert.equal(await signed.page.locator('.nav-user-popup--open').count(), 1, 'account popup opens');
    await signed.page.locator('.nav-user-popup-item[data-nav-id="settings"]').click();
    await signed.page.waitForURL('**/settings', { timeout: 10_000 });

    assert.deepEqual(signed.pageErrors, []);
    await signed.page.close();

    const guest = await openApp(browser, `${origin}/home`, GUEST_STUBS);
    await guest.page.waitForSelector('.left-nav .nav-item', { timeout: 30_000 });
    assert.equal(await guest.page.locator('.left-nav .nav-item').count(), 3, 'guest nav items');
    assert.ok(await guest.page.$('.nav-auth-buttons'), 'guest auth buttons');
    assert.ok(await guest.page.$('.nav-promo'), 'guest promo card');
    assert.equal(await guest.page.$('.nav-user-area'), null);
    await guest.page.locator('.nav-signin-button').first().click();
    await guest.page.waitForURL(/\/register|\/login/, { timeout: 10_000 });
    assert.deepEqual(guest.pageErrors, []);
    await guest.page.close();
  });
});

test('the right panel renders trending, games and routes every click', {
  timeout: 90_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const stubs = {
      ...SIGNED_IN_STUBS,
      '/api/tags/trending': {
        body: {
          tags: [
            { tag: 'flaxia', count: 120, percentage: 42 },
            { tag: 'indiegame', count: 80, percentage: 30 },
          ],
        },
      },
      '/api/games': {
        body: {
          games: [{ id: 'p1', postId: 'g1', title: 'Demo Game', username: 'bob', freshCount: 3, impressions: 42 }],
        },
      },
    };
    const { page, pageErrors } = await openApp(browser, `${origin}/home`, stubs);
    await page.waitForSelector('.right-panel', { timeout: 30_000 });
    await page.waitForSelector('.trending-item', { timeout: 10_000 });

    assert.equal(await page.locator('.trending-item').count(), 2);
    assert.equal(await page.locator('.right-panel .search-icon').count(), 1);
    assert.ok((await page.locator('.right-panel .search-kbd').textContent())?.trim());
    assert.equal(await page.locator('.game-item').count(), 1);
    assert.match((await page.locator('.trending-count').first().textContent()) ?? '', /%/);

    await page.fill('.right-panel .search-input', 'flaxia');
    await page.press('.right-panel .search-input', 'Enter');
    await page.waitForURL('**/search?q=flaxia&type=posts', { timeout: 10_000 });

    await page.goto(`${origin}/home`, { waitUntil: 'load' });
    await page.waitForSelector('.trending-item', { timeout: 10_000 });
    await page.locator('.trending-item').first().click();
    await page.waitForURL('**/explore?tag=flaxia', { timeout: 10_000 });

    await page.goto(`${origin}/home`, { waitUntil: 'load' });
    await page.waitForSelector('.game-item', { timeout: 10_000 });
    await page.locator('.game-item').first().click();
    await page.waitForURL('**/arcade/g1', { timeout: 10_000 });

    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('/arcade renders the Svelte player chrome and deep-links a game', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const game = {
      id: 'g1',
      postId: 'g1',
      title: 'Deep Link Game',
      username: 'bob',
      displayName: 'Bob',
      type: 'html5',
      freshCount: 7,
      replyCount: 0,
      bookmarkCount: 2,
      impressions: 10,
      createdAt: new Date().toISOString(),
    };
    const stubs = {
      ...SIGNED_IN_STUBS,
      '/api/games': { body: { games: [game], hasMore: false } },
      '/api/posts/g1/thread': { body: { root: { ...TIMELINE_POST, id: 'g1' }, replies: [] } },
    };
    const { page, pageErrors } = await openApp(browser, `${origin}/arcade/g1`, stubs);

    await page.waitForSelector('.arcade-page', { timeout: 30_000 });
    await page.waitForSelector('.arcade-header-title-text', { timeout: 10_000 });
    assert.match((await page.locator('.arcade-header-title-text').textContent()) ?? '', /Arcade/);

    // The first visit opens the tour; close it before interacting with the HUD.
    await page.waitForSelector('.arcade-tutorial-card', { timeout: 10_000 });
    await page.locator('.arcade-tutorial-close').click();
    await page.waitForSelector('.arcade-tutorial-card', { state: 'detached', timeout: 10_000 });

    await page.waitForSelector('.arcade-game-area iframe', { timeout: 20_000 });
    assert.equal(await page.locator('.arcade-action-btn').count(), 6);
    assert.match((await page.locator('.arcade-game-area iframe').getAttribute('src')) ?? '', /\/api\/games\/html5\/g1/);
    assert.match((await page.locator('.arcade-game-title').textContent()) ?? '', /Deep Link Game/);

    await page.locator('[data-action="comments"]').click();
    await page.waitForSelector('.arcade-comments-dialog', { timeout: 10_000 });
    assert.match((await page.locator('#arcade-comments-title').textContent()) ?? '', /(Thread|投稿)/);
    await page.locator('.arcade-comments-close').click();
    await page.waitForSelector('.arcade-comments-dialog', { state: 'detached', timeout: 10_000 });

    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('surface pages use the 600px centre without a right rail', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const stubs = SIGNED_IN_STUBS;

    const settings = await openApp(browser, `${origin}/settings`, stubs, { width: 1400, height: 1000 });
    await settings.page.waitForSelector('.settings-page', { timeout: 30_000 });
    const layout = await settings.page.evaluate(() => {
      const nav = document.querySelector('.left-nav')?.getBoundingClientRect();
      const content = document.querySelector('.main-content')?.getBoundingClientRect();
      return {
        nav: Math.round(nav?.width ?? 0),
        content: Math.round(content?.width ?? 0),
        right: Boolean(document.querySelector('.right-panel')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(layout.right, false, '/settings must not mount the right rail');
    assert.equal(layout.content, 600, 'surface content keeps the 600px centre');
    assert.ok(layout.overflow <= 1, `no horizontal overflow (${layout.overflow}px)`);
    await settings.page.close();

    const mail = await openApp(browser, `${origin}/mail`, stubs, { width: 1400, height: 1000 });
    await mail.page.waitForSelector('.mail-page', { timeout: 30_000 });
    assert.equal(await mail.page.$('.right-panel'), null, '/mail must not mount the right rail');
    await mail.page.close();

    const home = await openApp(browser, `${origin}/home`, stubs, { width: 1400, height: 1000 });
    await home.page.waitForSelector('.post-card', { timeout: 30_000 });
    const homeLayout = await home.page.evaluate(() => {
      const w = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
      return { nav: w('.left-nav'), content: w('.main-content'), right: w('.right-panel') };
    });
    assert.ok(homeLayout.right > 0, 'feed pages keep the right rail');
    assert.equal(homeLayout.content, 600, 'feed content keeps the 600px centre');
    assert.equal(homeLayout.nav + homeLayout.content + homeLayout.right, 1190, 'the three panes total 1190px');
    await home.page.close();
  });
});

test('the document title follows client-side navigation', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/explore`, SIGNED_IN_STUBS);
    await page.waitForSelector('.main-container', { timeout: 30_000 });
    const exploreTitle = await page.title();
    assert.match(exploreTitle, /^Flaxia - /, 'section pages get a Flaxia-prefixed title');
    assert.notEqual(exploreTitle, 'Flaxia');

    await page
      .locator('.left-nav button')
      .filter({ hasText: /ホーム|Home/ })
      .first()
      .click();
    await page.waitForURL('**/home', { timeout: 10_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.title(), 'Flaxia', 'home keeps the brand-only title');
    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('the post modal keeps the composer open while a confirm dialog is on top', {
  timeout: 90_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, SIGNED_IN_STUBS);
    await page.waitForSelector('.post-card', { timeout: 30_000 });

    await page.click('.post-card .action-button--reload');
    await page.waitForSelector('.post-action-dropdown-item');
    // reload / quote / share (labels are localized)
    await page.locator('.post-action-dropdown-item').nth(1).click();
    await page.waitForSelector('.post-modal-overlay', { timeout: 10_000 });
    assert.ok(await page.$('.post-modal-dialog .post-composer'), 'composer must mount inside the modal');
    assert.ok(await page.$('.post-modal-drafts'), 'the drafts panel must render');

    // save draft / delete all
    await page.locator('.post-modal-drafts button').nth(1).click();
    await page.waitForSelector('.fx-confirm-overlay', { timeout: 10_000 });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(await page.$('.fx-confirm-overlay'), null, 'Escape must close the confirm dialog');
    assert.ok(await page.$('.post-modal-overlay'), 'Escape must not close the composer behind the confirm');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(await page.$('.post-modal-overlay'), null, 'Escape closes the composer once it is the top layer');
    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('the share modal mounts, traps focus and closes with Escape', {
  timeout: 90_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, SIGNED_IN_STUBS);
    await page.waitForSelector('.post-card', { timeout: 30_000 });

    await page.click('.post-card .action-button--reload');
    await page.waitForSelector('.post-action-dropdown-item');
    await page.locator('.post-action-dropdown-item').nth(2).click();

    await page.waitForSelector('.fx-share-overlay', { timeout: 10_000 });
    assert.ok(await page.$('.fx-share-modal'), 'the share dialog renders');
    assert.match((await page.inputValue('.fx-share__link')) ?? '', /\/thread\/p1$/);
    assert.equal(await page.locator('.fx-share__grid .share-icon').count(), 6, 'every platform tile is present');
    assert.equal(
      await page.evaluate(() => Boolean(document.activeElement?.closest('.fx-share-modal'))),
      true,
      'focus starts inside the dialog',
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert.equal(await page.$('.fx-share-overlay'), null, 'Escape closes the share dialog');
    assert.equal(await page.evaluate(() => document.body.style.position), '', 'closing unlocks body scroll');
    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('post modal drafts save, reload and delete through the Svelte panel', {
  timeout: 90_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, SIGNED_IN_STUBS);
    await page.waitForSelector('.post-card', { timeout: 30_000 });
    await page.click('.post-card .action-button--reload');
    await page.waitForSelector('.post-action-dropdown-item');
    await page.locator('.post-action-dropdown-item').nth(1).click();
    await page.waitForSelector('.post-modal-overlay', { timeout: 10_000 });

    assert.ok(
      await page.$('.post-modal-dialog .composer-quoted-post'),
      'quoting opens the composer with the quoted post attached',
    );

    await page.fill('.post-modal-dialog .composer-textarea', 'draft body');
    await page.locator('.post-modal-drafts-save').click();
    await page.waitForSelector('.post-modal-draft-item', { timeout: 10_000 });
    assert.equal(await page.locator('.post-modal-draft-item').count(), 1);
    assert.match(
      await page.locator('.post-modal-drafts-title').textContent(),
      /\(1\)/,
      'the drafts title shows the count',
    );

    // Close and reopen: the saved draft comes back from storage.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.click('.post-card .action-button--reload');
    await page.waitForSelector('.post-action-dropdown-item');
    await page.locator('.post-action-dropdown-item').nth(1).click();
    await page.waitForSelector('.post-modal-draft-item', { timeout: 10_000 });
    assert.equal(await page.locator('.post-modal-draft-item').count(), 1);

    await page.locator('.post-modal-draft-text').click();
    assert.equal(await page.inputValue('.post-modal-dialog .composer-textarea'), 'draft body');

    await page.locator('.post-modal-draft-del').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.post-modal-draft-item').count(), 0);
    assert.ok(await page.$('.post-modal-drafts-empty'), 'the empty state returns');
    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('closing the post modal restores focus and body scrolling', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, SIGNED_IN_STUBS, { width: 390, height: 844 });
    await page.waitForSelector('.timeline-fab', { timeout: 30_000 });
    // The FAB is hidden while the lead composer is in view; reveal it for the
    // opener/focus check.
    await page.evaluate(() => document.querySelector('.timeline-fab')?.classList.add('visible'));
    await page.click('.timeline-fab');
    await page.waitForSelector('.post-modal-overlay', { timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.body.style.position), 'fixed', 'an open modal locks scroll');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(await page.$('.post-modal-overlay'), null);
    assert.equal(await page.evaluate(() => document.body.style.position), '', 'closing restores body scrolling');
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains('timeline-fab') ?? false),
      true,
      'focus returns to the opener',
    );
    assert.deepEqual(pageErrors, []);
    await page.close();
  });
});

test('a signed-in reply composer mounts, counts characters and suggests mentions', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, SIGNED_IN_STUBS);
    await page.waitForSelector('.post-card', { timeout: 30_000 });

    // Signed-in users get neither the rail compose button nor the guest promo.
    assert.equal(await page.$('.nav-post-button'), null, 'signed-in rail must not show a compose button');
    assert.equal(await page.$('.nav-promo'), null, 'signed-in rail must not show the guest promo');

    await page.click('.post-card .action-button--reply');
    await page.waitForSelector('.reply-composer', { timeout: 10_000 });

    const initial = await page.evaluate(() => {
      const textarea = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('.reply-composer-textarea'));
      const submit = /** @type {HTMLButtonElement | null} */ (document.querySelector('.reply-composer-submit'));
      return {
        placeholder: textarea?.placeholder ?? '',
        maxLength: textarea?.maxLength ?? 0,
        submitDisabled: submit?.disabled ?? false,
        charCount: document.querySelector('.reply-composer-char-count')?.textContent?.trim() ?? '',
        buttons: document.querySelectorAll('.reply-composer-buttons button').length,
      };
    });

    assert.ok(initial.placeholder.length > 0, 'composer placeholder missing');
    assert.equal(initial.maxLength, 200);
    assert.equal(initial.submitDisabled, true);
    assert.equal(initial.charCount, '0/200');
    assert.equal(initial.buttons, 2);

    await page.fill('.reply-composer-textarea', 'Nice post');

    const typed = await page.evaluate(() => ({
      submitDisabled: document.querySelector('.reply-composer-submit')?.disabled ?? true,
      charCount: document.querySelector('.reply-composer-char-count')?.textContent?.trim() ?? '',
    }));
    assert.equal(typed.submitDisabled, false, 'submit should enable once there is content');
    assert.equal(typed.charCount, '9/200');

    // Mention suggestions are a keyed list fed by the search endpoint. Stub
    // the request in the page: WebKit does not reliably route this fetch
    // through Playwright's request router, and the static server would answer
    // with index.html.
    await page.evaluate(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.includes('/api/search') && url.includes('type=users')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [{ username: 'quoted', display_name: 'Quoted', avatar_key: null }],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return nativeFetch(input, init);
      };
    });

    // Set the value and caret explicitly: WebKit's fill() can leave the
    // selection at 0, which makes the @-query parser see no mention.
    await page.evaluate(() => {
      const textarea = document.querySelector('.reply-composer-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      textarea.focus();
      textarea.value = 'Hi @qu';
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForSelector('.mention-dropdown .mention-item', { state: 'attached', timeout: 10_000 });

    const suggestions = await page.evaluate(() => ({
      items: [...document.querySelectorAll('.mention-dropdown .mention-item')].map((item) => ({
        value: item.getAttribute('data-value'),
        active: item.classList.contains('mention-item--active'),
        text: (item.textContent ?? '').trim(),
      })),
    }));

    assert.equal(suggestions.items.length, 1);
    assert.equal(suggestions.items[0].value, 'quoted');
    assert.ok(suggestions.items[0].active, 'first suggestion should start active');
    assert.match(suggestions.items[0].text, /@quoted/);

    // Picking the suggestion rewrites the draft.
    await page.click('.mention-dropdown .mention-item');
    const draft = await page.inputValue('.reply-composer-textarea');
    assert.equal(draft, 'Hi @quoted ');

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });
});

test('the thread page renders nested Svelte reply nodes and expands branches', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/thread/thread-root`, REPLY_TREE_STUBS);
    // ReplyNode is the Twitter-style tree; the default setting is flat.
    await page.evaluate(() => localStorage.setItem('flaxia_reply_style', 'twitter'));
    await page.reload({ waitUntil: 'load' });

    await page.waitForSelector('.reply-node', { timeout: 30_000 });
    assert.equal(await page.locator('.reply-node').count(), 2, 'parent and nested reply should both render');
    assert.equal(await page.locator('.reply-node .reply-expand-button').count(), 1);

    const children = page.locator('.reply-node .reply-children').first();
    assert.equal(await children.isVisible(), false, 'nested replies start collapsed');
    await page.locator('.reply-node .reply-expand-button').first().click();
    assert.equal(await children.isVisible(), true, 'expanding reveals the nested reply');

    const text = await page.evaluate(() => document.querySelector('.reply-node .post-text')?.textContent?.trim() ?? '');
    assert.match(text, /First reply/);
    assert.ok(await page.locator('.reply-node .post-actions .action-button--reply').first().isVisible());
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await page.close();
  });
});

test('a ZIP game can open a multiplayer room through the host page', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/thread/zip-post`, ZIP_STUBS, undefined, {
      sandboxHtml: () => ZIP_GAME_HTML,
    });

    const createRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/multiplayer/rooms',
      { timeout: 30_000 },
    );
    const joinRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/api/multiplayer/rooms/room-1/join',
      { timeout: 30_000 },
    );

    await page.waitForSelector('.zip-execution-button', { timeout: 30_000 });
    await page.locator('.zip-execution-button').first().click();

    let gameFrame = null;
    for (let i = 0; i < 30; i++) {
      gameFrame = page.frames().find((frame) => frame.url().includes('/api/wvfs-zip/zip-post'));
      if (gameFrame) break;
      await page.waitForTimeout(500);
    }
    assert.ok(gameFrame, 'ZIP game frame did not load');

    // The regression: the ZIP player ignored MULTIPLAYER_CONNECT, so neither
    // request was ever made and the game sat in its 12s connect timeout.
    await Promise.all([createRequest, joinRequest]);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await page.close();
  });
});

test('inline post editing keeps the saved text when reopened', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/home`, EDIT_STUBS);
    await page.waitForSelector('.post-card', { timeout: 30_000 });

    const openEdit = async () => {
      await page.locator('.post-menu-button').first().click();
      await page
        .locator('.post-menu-dropdown .fx-menu-item')
        .filter({ hasText: /Edit|編集/ })
        .first()
        .click();
      await page.waitForSelector('.edit-textarea', { timeout: 10_000 });
    };

    await openEdit();
    await page.locator('.edit-textarea').fill('edited text');
    await page
      .locator('.edit-container button')
      .filter({ hasText: /Save|保存/ })
      .click();

    await page.waitForFunction(
      () => (document.querySelector('.post-card .post-text')?.textContent ?? '').includes('edited text'),
      { timeout: 10_000 },
    );

    await openEdit();
    assert.equal(await page.locator('.edit-textarea').inputValue(), 'edited text');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await page.close();
  });
});

test('the feed renders the Svelte ad card', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/home`, AD_STUBS);

    await page.waitForSelector('.ad-banner', { timeout: 30_000 });
    const result = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('.ad-banner .ad-label')].map((node) => (node.textContent ?? '').trim()),
      placeholders: document.querySelectorAll('.ad-banner .ad-placeholder').length,
      gate: document.querySelectorAll('.ad-banner .ad-gate').length,
    }));

    assert.ok(
      result.labels.some((label) => label === 'Sponsored' || label === 'スポンサー'),
      `sponsored label missing: ${result.labels.join(', ')}`,
    );
    assert.ok(result.placeholders >= 1, 'ad placeholder missing');
    assert.equal(result.gate, 0, 'data saver is off, so the ad must not be gated');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await page.close();
  });
});

test('layout stays put while async panels and media settle (CLS / LCP budget)', { timeout: 180_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const cases = [
      { label: 'timeline 1400x1000', path: '/', stubs: MEDIA_STUBS, viewport: { width: 1400, height: 1000 } },
      {
        label: 'settings 1400x1000',
        path: '/settings',
        stubs: SIGNED_IN_STUBS,
        viewport: { width: 1400, height: 1000 },
      },
      { label: 'timeline 390x844', path: '/', stubs: MEDIA_STUBS, viewport: { width: 390, height: 844 } },
      {
        label: 'timeline+async rail 1400x1000',
        path: '/',
        stubs: BUSY_STUBS,
        viewport: { width: 1400, height: 1000 },
      },
    ];

    for (const testCase of cases) {
      const { page, pageErrors } = await openApp(
        browser,
        `${origin}${testCase.path}`,
        testCase.stubs,
        testCase.viewport,
        { measurePerformance: true, imageDelayMs: 600 },
      );

      await page.waitForSelector('.main-container', { timeout: 30_000 });
      if (testCase.path === '/') {
        await page.waitForSelector('.post-card .image-preview', { timeout: 30_000 });
      } else {
        await page.waitForSelector('.settings-section', { timeout: 30_000 });
      }
      // Wait past the delayed media response plus a settle window so async
      // panels (right rail, settings sections) finish before we read the budget.
      await page.waitForTimeout(1800);

      const perf = await page.evaluate(() => window.__flaxiaPerf ?? { cls: -1, lcp: -1, shifts: [] });

      if (testCase.path === '/') {
        const media = await page.evaluate(() => {
          const img = document.querySelector('.post-card .image-preview img');
          return {
            loaded: !!img && img.naturalWidth > 0,
            boxHeight: document.querySelector('.post-card .image-preview')?.getBoundingClientRect().height ?? 0,
          };
        });
        assert.ok(media.loaded, `${testCase.label}: stubbed image never loaded`);
        assert.ok(media.boxHeight > 100, `${testCase.label}: media box has no reserved height`);
      }

      if (testCase.stubs === BUSY_STUBS) {
        // The rail's variable-height cards are filled asynchronously; the
        // column keeps its width so the feed cannot shift.
        const rail = await page.evaluate(() => ({
          visibility: getComputedStyle(document.querySelector('.right-panel')).visibility,
          tags: document.querySelectorAll('.trending-list .trending-item').length,
          helpItems: document.querySelectorAll('.help-list .help-item').length,
        }));
        assert.equal(rail.visibility, 'visible', `${testCase.label}: rail stayed hidden`);
        assert.equal(rail.tags, 4, `${testCase.label}: expected 4 trending tags, got ${rail.tags}`);
        assert.ok(rail.helpItems >= 1, `${testCase.label}: help card is empty`);
      }

      assert.ok(perf.lcp > 0, `${testCase.label}: no LCP entry recorded`);
      assert.ok(
        perf.cls < 0.02,
        `${testCase.label}: CLS ${perf.cls.toFixed(4)} exceeds budget; shifts=${JSON.stringify(perf.shifts)}`,
      );
      assert.deepEqual(pageErrors, [], `${testCase.label}: page errors: ${pageErrors.join(' | ')}`);

      console.log(
        `${testCase.label}: cls=${perf.cls.toFixed(4)} lcp=${perf.lcp.toFixed(0)}ms shifts=${perf.shifts.length}`,
      );
      await page.close();
    }
  });
});

test('the bottom nav follows the route instead of keeping the Arcade tab', { timeout: 120_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/arcade`, SIGNED_IN_STUBS, {
      width: 390,
      height: 844,
    });

    await page.waitForSelector('.bottom-nav', { state: 'attached', timeout: 30_000 });

    const activeTabs = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.bottom-nav-item--active')].map((item) => item.getAttribute('data-nav-id')),
      );
    const navigateTo = async (path) => {
      await page.evaluate((target) => {
        window.history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, path);
      // The router renders lazily (Maps pulls the MapLibre chunk).
      await page.waitForTimeout(1500);
    };

    // The bar is created during the first auth check, after the initial
    // navigateTo(); it must still start on the Arcade tab.
    assert.deepEqual(await activeTabs(), ['arcade'], 'initial /arcade should light the Arcade tab');

    // Maps has no tab: the highlight has to clear, not stay on Arcade.
    await navigateTo('/maps');
    assert.deepEqual(await activeTabs(), [], 'Maps must not keep the Arcade tab lit');

    await navigateTo('/translate');
    assert.deepEqual(await activeTabs(), [], 'Translate must not keep the Arcade tab lit');

    await navigateTo('/home');
    assert.deepEqual(await activeTabs(), ['home']);

    await navigateTo('/arcade');
    assert.deepEqual(await activeTabs(), ['arcade']);

    await navigateTo('/explore');
    assert.deepEqual(await activeTabs(), ['explore']);

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });
});
