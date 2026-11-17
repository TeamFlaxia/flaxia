// Real-app shell smoke test.
//
// Boots the actual `vite build` output (dist/index.html + hashed assets) against a
// static file server and a stubbed /api, then checks that the layered stylesheet
// still produces the three-column shell. This is the guard for the Phase 5 CSS
// layer entry: a cascade regression shows up as a collapsed column or a broken
// background token, not just as a failed unit test.
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

const API_STUBS = {
  '/api/auth/me': { status: 401, body: {} },
  '/api/posts': { status: 200, body: { posts: [], nextCursor: null } },
  '/api/posts/recommended': { status: 200, body: { posts: [], nextCursor: null } },
  '/api/trending': { status: 200, body: { tags: [] } },
  '/api/users/suggested': { status: 200, body: { users: [] } },
  '/api/ads': { status: 200, body: { ads: [] } },
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

test('the built app boots into the layered three-column shell', { timeout: 90_000 }, async () => {
  const server = createStaticServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let browser;
  try {
    try {
      browser = await engine.launch(browserName === 'chromium' ? { channel: 'chrome' } : {});
    } catch {
      browser = await engine.launch();
    }

    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    // Block third-party traffic (fonts, AdSense, crowd node). The shell must
    // render without any of it.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });

    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url());
      const stub = API_STUBS[url.pathname];
      return route.fulfill({
        status: stub?.status ?? 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(stub?.body ?? {}),
      });
    });

    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
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

      const shell = document.querySelector('.main-container');
      const columns = [...(shell?.children ?? [])].map((element) => ({
        className: element.className,
        width: element.getBoundingClientRect().width,
      }));

      return {
        layers: layerNames,
        columns,
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
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
