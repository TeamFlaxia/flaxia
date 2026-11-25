// Empirical latency harness for the two hot paths of the built app:
//
//   1. /home boot -> interactive timeline (`flaxia:ssr-handover`);
//   2. clicking a post card -> rendered thread (`.thread-page .reply-node`).
//
// Mirrors tests/app-shell.browser.mjs: the same static server over `dist/`, the
// same stubbed /api and the same no-third-party-request routing. A single
// init script installs the performance marks before any app script runs, so
// client-side navigation keeps accumulating into the same marks object.
//
// Run with (the dist build must already exist, CI builds it once):
//   npm run test:perf:browser
//   PERF_BUDGET_MS=800 PERF_ITERATIONS=5 npm run test:perf:browser
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

const SIGNED_IN_STUBS = {
  '/api/me': { body: { user: { id: 'u1', username: 'mikan', display_name: 'Mikan', language: 'en' } } },
  '/api/posts': { body: { posts: [], nextCursor: null } },
  '/api/posts/recommended': { body: { posts: [], nextCursor: null } },
  '/api/trending': { body: { tags: [] } },
  '/api/users/suggested': { body: { users: [] } },
  '/api/ads': { body: { ads: [] } },
  '/api/ads/active': { body: { ads: [] } },
  '/api/tags/trending': { body: { tags: [] } },
  '/api/users/suggestions': { body: { users: [] } },
  '/api/search': { body: { results: [] } },
  '/api/tags/suggest': { body: { tags: [] } },
  '/api/games': { body: { games: [], next_cursor: null } },
  '/api/auth/recovery/status': { status: 404, body: {} },
  '/api/titles/me': { body: { titles: [] } },
  '/api/stamps': { body: { stamps: [] } },
  '/api/billing/plan': { body: { plan: null, status: 'none' } },
  '/api/billing/transactions': { body: { transactions: [] } },
};

// One deterministic post, no media/links/quotes: the click has a single target
// and the timeline has exactly one card to render.
const PERF_POST = {
  id: 'perf-post-1',
  user_id: 'u1',
  username: 'mikan',
  display_name: 'Mikan',
  text: 'Deterministic post for the boot and thread latency harness.',
  hashtags: '',
  mentions: '[]',
  created_at: '2026-11-26T00:00:00.000Z',
  fresh_count: 0,
  reply_count: 1,
  reload_count: 0,
  bookmark_count: 0,
  impressions: 0,
  depth: 0,
  quoted_post_id: null,
  quoted_post: null,
  reactions: [],
};

const PERF_REPLY = {
  ...PERF_POST,
  id: 'perf-reply-1',
  text: 'Deterministic reply for the thread render.',
  parent_id: PERF_POST.id,
  root_id: PERF_POST.id,
  depth: 1,
  reply_count: 0,
};

const PERF_STUBS = {
  ...SIGNED_IN_STUBS,
  '/api/posts': { body: { posts: [PERF_POST], nextCursor: null } },
  '/api/posts/recommended': { body: { posts: [PERF_POST], nextCursor: null } },
  '/api/posts/perf-post-1': { body: { post: PERF_POST } },
  '/api/posts/perf-post-1/thread': { body: { root: PERF_POST, replies: [PERF_REPLY] } },
};

// 1x1 transparent PNG for any incidental image request.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Installed with page.addInitScript before any app code. `performance.mark`
 * puts every milestone on the browser timeline; the plain `marks` map keeps
 * the first occurrence of each label so `measures()` can return durations
 * even after a client-side navigation replaced the document body.
 */
const PERF_INIT_SCRIPT = () => {
  // render-diagnostics.ts checks this flag at boot (or ?render-debug=1).
  window.__FLXIA_RENDER_DEBUG__ = true;
  // The reply tree (rather than the flat 2ch list) renders `.reply-node`.
  try {
    localStorage.setItem('flaxia_reply_style', 'twitter');
  } catch {
    // Opaque origins can reject localStorage; the harness still runs.
  }

  const marks = Object.create(null);
  const mark = (name) => {
    if (marks[name] === undefined) marks[name] = performance.now();
    try {
      performance.mark(`flaxia:${name}`);
    } catch {
      // Not every engine accepts arbitrary mark names.
    }
  };

  // Navigation is the zero point for the "time to ..." milestones.
  mark('navigation');

  const labelFor = (url) => {
    try {
      const path = new URL(url, location.href).pathname;
      if (path === '/api/me') return 'apiMe';
      if (path.startsWith('/locales/')) return 'locales';
      if (path === '/api/posts') return 'apiPosts';
      if (/^\/api\/posts\/[^/]+\/thread$/.test(path)) return 'threadApi';
    } catch {
      // Unparseable URLs are not part of the measured boot path.
    }
    return null;
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const requested =
      typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input);
    const label = labelFor(requested);
    if (!label) return nativeFetch(input, init);

    const start = `${label}:start`;
    const end = `${label}:end`;
    if (marks[start] === undefined) mark(start);
    const settle = (value) => {
      if (marks[end] === undefined) mark(end);
      return value;
    };
    return nativeFetch(input, init).then(settle, (error) => {
      settle(undefined);
      throw error;
    });
  };

  window.addEventListener('flaxia:session', () => mark('session'));
  window.addEventListener('flaxia:ssr-handover', () => mark('handover'));

  // Capture phase: the post card's own click handler runs later in bubble.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (
        marks.postClick === undefined &&
        target &&
        typeof target.closest === 'function' &&
        target.closest('.post-card')
      ) {
        mark('postClick');
      }
    },
    true,
  );

  const observer = new MutationObserver(() => {
    if (marks.shell === undefined && document.querySelector('.main-container')) mark('shell');
    if (marks.replyNode === undefined && document.querySelector('.thread-page .reply-node')) mark('replyNode');
  });
  observer.observe(document, { childList: true, subtree: true });
  // The static shell may already be in the DOM when this script runs.
  if (document.querySelector('.main-container')) mark('shell');

  window.__flaxiaPerfMarks = {
    marks: () => ({ ...marks }),
    measures() {
      const span = (from, to) => {
        const start = marks[from];
        const end = marks[to];
        return start === undefined || end === undefined ? null : Math.round((end - start) * 100) / 100;
      };
      const sinceNavigation = (name) => {
        const at = marks[name];
        return at === undefined ? null : Math.round((at - marks.navigation) * 100) / 100;
      };
      return {
        navigation: 0,
        apiMe: span('apiMe:start', 'apiMe:end'),
        locales: span('locales:start', 'locales:end'),
        apiPosts: span('apiPosts:start', 'apiPosts:end'),
        threadApi: span('threadApi:start', 'threadApi:end'),
        shell: sinceNavigation('shell'),
        session: sinceNavigation('session'),
        handover: sinceNavigation('handover'),
        postClick: sinceNavigation('postClick'),
        replyNode: sinceNavigation('replyNode'),
        clickToThread: span('postClick', 'replyNode'),
      };
    },
  };
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

async function openApp(browser, url, stubs) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.addInitScript(PERF_INIT_SCRIPT);

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== '127.0.0.1') return route.abort();
    if (requestUrl.pathname.startsWith('/api/ws/')) return route.continue();
    if (requestUrl.pathname.startsWith('/api/')) {
      if (requestUrl.pathname.startsWith('/api/images/')) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
      }
      const stub = stubs[requestUrl.pathname];
      return route.fulfill({
        status: stub?.status ?? 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(stub?.body ?? {}),
      });
    }
    // /locales/*.json is served by the static server (and still marked).
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

function median(values, label) {
  assert.ok(values.length > 0, `${label}: no samples`);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

test('boot and post -> thread navigation stay inside the latency budget', { timeout: 120_000 }, async () => {
  const budgetMs = Number(process.env.PERF_BUDGET_MS ?? 500);
  const iterations = Math.max(1, Number(process.env.PERF_ITERATIONS ?? 3));
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, `invalid PERF_BUDGET_MS: ${process.env.PERF_BUDGET_MS}`);
  assert.ok(Number.isInteger(iterations), `invalid PERF_ITERATIONS: ${process.env.PERF_ITERATIONS}`);

  await withServer(async ({ browser, origin }) => {
    const samples = [];
    for (let index = 0; index < iterations; index++) {
      const { page, pageErrors } = await openApp(browser, `${origin}/home`, PERF_STUBS);
      try {
        await page.waitForSelector('.post-card', { timeout: 30_000 });
        await page.waitForFunction(
          () => !!window.__flaxiaPerfMarks && window.__flaxiaPerfMarks.measures().handover !== null,
          { timeout: 30_000 },
        );

        await page.locator('.post-card .post-text').first().click();
        await page.waitForURL(/\/thread\/perf-post-1$/, { timeout: 15_000 });
        await page.waitForSelector('.thread-page .reply-node', { timeout: 30_000 });
        await page.waitForFunction(
          () => !!window.__flaxiaPerfMarks && window.__flaxiaPerfMarks.measures().clickToThread !== null,
          { timeout: 15_000 },
        );

        const measures = await page.evaluate(() => window.__flaxiaPerfMarks.measures());
        assert.deepEqual(pageErrors, [], `sample ${index + 1}: page errors: ${pageErrors.join(' | ')}`);
        samples.push(measures);
        console.log(`[perf] sample ${index + 1}/${iterations}: ${JSON.stringify(measures)}`);
      } finally {
        await page.close();
      }
    }

    const collect = (key) => {
      const values = samples
        .map((sample) => sample[key])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      assert.equal(values.length, iterations, `missing ${key} samples`);
      return values;
    };
    const boot = median(collect('handover'), 'handover');
    const navigation = median(collect('clickToThread'), 'clickToThread');
    console.log(
      `[perf] medians over ${iterations} run(s): boot->handover ${boot}ms, click->reply ${navigation}ms (budget ${budgetMs}ms)`,
    );
    assert.ok(boot <= budgetMs, `median boot->handover ${boot}ms exceeds ${budgetMs}ms`);
    assert.ok(navigation <= budgetMs, `median click->reply ${navigation}ms exceeds ${budgetMs}ms`);
  });
});
