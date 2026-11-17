// Real-app smoke tests.
//
// Boots the actual `vite build` output (dist/index.html + hashed assets) against
// a static file server and a stubbed /api. Two surfaces are checked:
//
//   1. the guest shell (layered CSS still produces the three-column layout);
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

const GUEST_STUBS = {
  '/api/me': { status: 401, body: {} },
  '/api/posts': { body: { posts: [], nextCursor: null } },
  '/api/posts/recommended': { body: { posts: [], nextCursor: null } },
  '/api/trending': { body: { tags: [] } },
  '/api/users/suggested': { body: { users: [] } },
  '/api/ads': { body: { ads: [] } },
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
async function openApp(browser, url, stubs) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });

  await page.route('**/api/**', (route) => {
    const requestUrl = new URL(route.request().url());
    const stub = stubs[requestUrl.pathname];
    return route.fulfill({
      status: stub?.status ?? 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(stub?.body ?? {}),
    });
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

test('the built app boots into the layered three-column shell', { timeout: 90_000 }, async () => {
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
        layers: layerNames,
        left: measure('.left-nav'),
        center: measure('.timeline, .main-content'),
        right: measure('.right-panel'),
        appChildren: document.querySelector('#app')?.children.length ?? 0,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        textColor: getComputedStyle(document.body).color,
      };
    });

    // The shared layer entry is what the app actually ships.
    assert.ok(result.layers.includes('legacy'), `legacy layer missing: ${result.layers.join(',')}`);
    assert.ok(result.layers.includes('primitives'), `primitives layer missing: ${result.layers.join(',')}`);

    // Guest shell: nav (240px) + content column + right rail (350px).
    assert.ok(result.appChildren > 0, '#app was never populated');
    assert.ok(result.left, 'left nav missing');
    assert.ok(Math.abs(result.left.width - 240) < 1, `left nav width: ${result.left.width}`);
    assert.ok(result.right, 'right rail missing');
    assert.ok(Math.abs(result.right.width - 350) < 1, `right rail width: ${result.right.width}`);
    assert.ok(result.center, 'content column missing');
    assert.ok(
      result.center.width >= 560 && result.center.width <= 620,
      `content column width out of range: ${result.center.width}`,
    );

    // Tokens still resolve: the layered entry must not drop the theme variables.
    assert.equal(result.bodyBackground, 'rgb(255, 255, 255)');
    assert.equal(result.textColor, 'rgb(15, 23, 42)');

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
