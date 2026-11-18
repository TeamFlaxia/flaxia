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
const assets = await readdir(join(distDir, 'assets'));
assert.ok(
  assets.some((file) => file.endsWith('.css')),
  'vite build must produce dist assets before this test',
);

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
    if (requestUrl.hostname !== '127.0.0.1') return route.abort();

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
        return { width: bounds.width, height: bounds.height };
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
      };
    });

    // Regression guard for the @layer experiment: layered app CSS loses to the
    // unlayered critical CSS inlined in index.html, which reverted the redesign
    // (240px nav, unpadded cards). The shipped CSS must stay unlayered.
    assert.equal(result.layerBlocks, 0, 'app CSS must not use @layer');

    // The shipped design: the legacy 240px nav + 600px content + 350px rail.
    assert.ok(result.appChildren > 0, '#app was never populated');
    assert.ok(result.left, 'left nav missing');
    assert.ok(Math.abs(result.left.width - 240) < 1, `left nav width: ${result.left.width}`);
    assert.ok(result.right, 'right rail missing');
    assert.ok(Math.abs(result.right.width - 350) < 1, `right rail width: ${result.right.width}`);
    assert.ok(result.center, 'content column missing');
    assert.ok(Math.abs(result.center.width - 600) < 1, `content column width: ${result.center.width}`);
    assert.equal(result.leftNavPadding, '16px');

    // Tokens and card chrome resolve to the legacy values.
    assert.equal(result.bodyBackground, 'rgb(255, 255, 255)');
    assert.equal(result.textColor, 'rgb(15, 23, 42)');
    assert.ok(result.postCard, 'post card missing');
    assert.equal(result.postCard.padding, '16px', `post card padding: ${result.postCard.padding}`);
    assert.equal(result.postCard.margin, '0px', `post card margin: ${result.postCard.margin}`);
    assert.equal(result.postCard.borderRadius, '0px');

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

test('the 768-1024px range keeps the right rail hidden and the drawer breakpoint sharp', {
  timeout: 120_000,
}, async () => {
  await withServer(async ({ browser, origin }) => {
    const cases = [
      // Exactly at the drawer breakpoint: bottom bar on, drawer off-canvas.
      { width: 768, height: 1024, mobile: true },
      { width: 900, height: 1024, mobile: false },
      // At the right-rail breakpoint the rail is already hidden.
      { width: 1024, height: 1024, mobile: false },
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

      // The right rail is hidden at and below 1024px.
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
        // The legacy layout keeps the full 240px rail until the drawers kick in.
        assert.ok(Math.abs(layout.leftNav.width - 240) < 1, `${label}: nav width ${layout.leftNav.width}`);
        assert.ok(layout.leftNav.left >= 0, `${label}: left nav should be on-screen`);
      }

      assert.deepEqual(pageErrors, [], `${label}: page errors: ${pageErrors.join(' | ')}`);
      await page.close();
    }
  });
});

test('a signed-in reply composer mounts, counts characters and suggests mentions', { timeout: 90_000 }, async () => {
  await withServer(async ({ browser, origin }) => {
    const { page, pageErrors } = await openApp(browser, `${origin}/`, SIGNED_IN_STUBS);
    await page.waitForSelector('.post-card', { timeout: 30_000 });

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
        // The rail reveals itself once the variable-height cards are filled.
        const rail = await page.evaluate(() => ({
          visibility: getComputedStyle(document.querySelector('.right-panel')).visibility,
          pending: document.querySelector('.right-panel')?.classList.contains('right-panel--pending'),
          tags: document.querySelectorAll('.trending-list .trending-item').length,
          weather: (document.querySelector('.maps-weather-section .right-card-body')?.textContent ?? '').trim(),
          followVisible: getComputedStyle(document.querySelector('.follow-section')).display !== 'none',
        }));
        assert.equal(rail.visibility, 'visible', `${testCase.label}: rail stayed hidden`);
        assert.equal(rail.pending, false, `${testCase.label}: rail still marked pending`);
        assert.equal(rail.tags, 4, `${testCase.label}: expected 4 trending tags, got ${rail.tags}`);
        assert.ok(rail.weather.length > 0, `${testCase.label}: weather body empty`);
        assert.ok(rail.followVisible, `${testCase.label}: follow card never revealed`);
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
