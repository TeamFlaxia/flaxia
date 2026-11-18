// Visual parity capture: serves a built dist with stubbed APIs, then records
// screenshots and computed styles for the main routes.
//
//   node tests/visual-parity.mjs --dist dist --out /tmp/parity/head --label head
//   node tests/visual-parity.mjs --dist .worktrees/base/dist --out /tmp/parity/base --label base
//   node tests/visual-parity.mjs --diff /tmp/parity/base/v-base.json /tmp/parity/head/v-head.json
//
// The numbers it prints are what `docs/visual-parity.md` records.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const ML = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

if (flag('diff')) {
  process.exit(await diff(flag('diff'), args[args.indexOf('--diff') + 2]));
}

const dist = flag('dist');
const outDir = flag('out');
const label = flag('label') ?? 'run';
if (!dist || !outDir) {
  console.error('usage: node tests/visual-parity.mjs --dist <dir> --out <dir> [--label name]');
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const post = {
  id: 'p1',
  user_id: 'u2',
  username: 'author',
  display_name: 'Author Name',
  text: 'Hello @quoted and #flaxia from the parity harness. This is a longer post body so line wrapping and spacing can be compared.',
  hashtags: 'flaxia',
  mentions: JSON.stringify([{ username: 'quoted', user_id: 'u3' }]),
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
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
    created_at: new Date(Date.now() - 7_200_000).toISOString(),
  },
  reactions: [
    { emoji: '💚', count: 2, reacted: false },
    { emoji: '🎉', count: 1, reacted: true },
  ],
  attachments: [{ r2_key: 'smoke.png', kind: 'image', position: 1 }],
};

const API = {
  '/api/me': { body: { user: { id: 'u1', username: 'mikan', display_name: 'Mikan', language: 'en' } } },
  '/api/posts': { body: { posts: [post], next_cursor: null } },
  '/api/posts/recommended': { body: { posts: [post], next_cursor: null } },
  '/api/ads/active': { body: { ads: [] } },
  '/api/tags/trending': { body: { tags: [{ tag: 'flaxia', count: 120, percentage: 42 }] } },
  '/api/users/suggestions': {
    body: { users: [{ username: 'quoted', display_name: 'Quoted', avatar_key: null }] },
  },
  '/api/maps/weather': {
    body: {
      points: [{ time: '2026-11-17T09:00:00Z', temperature: 18, humidity: 55, windSpeed: 3, symbol: 'clearsky_day' }],
    },
  },
  '/api/titles/me': { body: { titles: [] } },
  '/api/stamps': { body: { stamps: [] } },
  '/api/billing/plan': { body: { plan: 'flaxia_plus', status: 'active', expiresAt: '2026-12-01T00:00:00Z' } },
  '/api/billing/transactions': { body: { transactions: [] } },
  '/api/auth/recovery/status': { status: 404, body: {} },
  '/api/notifications': { body: { notifications: [], unreadCount: 0 } },
  '/api/bookmarks': { body: { posts: [], next_cursor: null } },
  '/api/games': {
    body: {
      games: [
        { id: 'g1', postId: 'p1', title: 'Neon Runner', username: 'author', freshCount: 12, impressions: 340 },
        { id: 'g2', postId: 'p2', title: 'Pixel Garden', username: 'mikan', freshCount: 8, impressions: 210 },
        { id: 'g3', postId: 'p3', title: 'Sky Fishing', username: 'quoted', freshCount: 5, impressions: 120 },
      ],
      next_cursor: null,
    },
  },
  '/api/mail/addresses': { body: { addresses: [] } },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = join(dist, decodeURIComponent(url.pathname));
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(dist, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(playwrightModule);
// Prefer the installed Chrome; fall back to Playwright's bundled build.
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

const SELECTORS = [
  'body',
  '.main-container',
  '.left-nav',
  '.timeline, .main-content',
  '.right-panel',
  '.post-card',
  '.post-header',
  '.post-avatar',
  '.post-display-name',
  '.post-username',
  '.post-timestamp',
  '.post-text',
  '.post-text p',
  '.post-actions',
  '.action-button',
  '.action-count',
  '.post-reaction-chip',
  '.quoted-post-card',
  '.image-preview',
  '.right-card',
  '.search-input',
  '.settings-page',
  '.settings-nav',
  '.settings-section',
];
const PROPS = [
  'display',
  'position',
  'width',
  'height',
  'padding',
  'margin',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'border-radius',
  'border-width',
  'gap',
  'max-width',
];

const results = { label, routes: {}, consoleErrors: [], pageErrors: [] };

async function capture(route, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => {
    if (m.type() === 'error') results.consoleErrors.push(`${route}@${viewport.width}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => results.pageErrors.push(`${route}@${viewport.width}: ${String(e).slice(0, 300)}`));

  await page.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
  await page.route('**/api/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.startsWith('/api/images/')) {
      return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    const stub = API[url.pathname];
    return r.fulfill({
      status: stub?.status ?? 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(stub?.body ?? {}),
    });
  });

  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const metrics = await page.evaluate(
    ({ selectors, props }) => {
      const out = {};
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) {
          out[selector] = null;
          continue;
        }
        const computed = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const values = { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        for (const prop of props) values[prop] = computed.getPropertyValue(prop);
        out[selector] = values;
      }
      return out;
    },
    { selectors: SELECTORS, props: PROPS },
  );

  const key = `${route.replace(/\//g, '_') || 'root'}@${viewport.width}`;
  results.routes[key] = metrics;
  await page.screenshot({ path: join(outDir, `${label}${key}.png`) });
  await page.close();
}

const DESKTOP_ROUTES = [
  '/',
  '/explore',
  '/arcade',
  '/maps',
  '/notifications',
  '/bookmarks',
  '/search?q=test',
  '/profile/author',
  '/thread/p1',
  '/mail',
  '/mail/new',
  '/settings',
  '/admin',
  '/docs',
  '/terms',
  '/download',
];
const MOBILE_ROUTES = ['/', '/explore', '/settings'];

for (const route of DESKTOP_ROUTES) await capture(route, { width: 1400, height: 1000 });
for (const route of MOBILE_ROUTES) await capture(route, { width: 390, height: 844 });

await writeFile(join(outDir, `${label}.json`), JSON.stringify(results, null, 1));
await browser.close();
server.close();
console.log(`captured ${label}: ${Object.keys(results.routes).length} routes -> ${outDir}`);

/**
 * Compares two capture files. Layout differences above 1px and any computed
 * style difference fail; textContent is not compared because the engine keeps
 * harmless block-level whitespace text nodes.
 */
async function diff(basePath, headPath) {
  if (!basePath || !headPath) {
    console.error('usage: --diff <base.json> <head.json>');
    return 1;
  }
  const base = JSON.parse(await readFile(basePath, 'utf8'));
  const head = JSON.parse(await readFile(headPath, 'utf8'));
  let failures = 0;

  for (const route of Object.keys(base.routes)) {
    const b = base.routes[route];
    const h = head.routes[route] ?? {};
    const diffs = [];
    for (const selector of Object.keys(b)) {
      const bb = b[selector];
      const hh = h[selector];
      if (!bb && !hh) continue;
      if (!bb || !hh) {
        diffs.push(`${selector}: ${bb ? 'missing in head' : 'missing in base'}`);
        continue;
      }
      for (const prop of Object.keys(bb)) {
        if (prop === 'rect') {
          const delta = Math.max(
            Math.abs(bb.rect.x - hh.rect.x),
            Math.abs(bb.rect.y - hh.rect.y),
            Math.abs(bb.rect.w - hh.rect.w),
            Math.abs(bb.rect.h - hh.rect.h),
          );
          if (delta > 1) {
            diffs.push(
              `${selector}.rect: Δ${delta.toFixed(1)}px ${JSON.stringify(bb.rect)} -> ${JSON.stringify(hh.rect)}`,
            );
          }
          continue;
        }
        if (bb[prop] === hh[prop]) continue;
        // Some engines serialise 50.2188px vs 50.2344px for the same glyph run
        // (1/64px rounding). Anything under a twentieth of a pixel is equal.
        const bp = /^(-?[\d.]+)px$/.exec(bb[prop]);
        const hp = /^(-?[\d.]+)px$/.exec(hh[prop]);
        if (bp && hp && Math.abs(Number(bp[1]) - Number(hp[1])) < 0.05) continue;
        diffs.push(`${selector}.${prop}: ${bb[prop]} -> ${hh[prop]}`);
      }
    }
    if (diffs.length) {
      failures += diffs.length;
      console.log(`\n${route} (${diffs.length})`);
      for (const line of diffs.slice(0, 20)) console.log(`  ${line}`);
    }
  }

  // Sub-pixel text widths differ by 1/64px between separate DOM shapes; treat
  // anything under 0.05px as equal (handled above by string equality only for
  // non-length props).
  console.log(failures === 0 ? '\nno layout/style differences' : `\n${failures} differences`);
  return failures === 0 ? 0 : 1;
}
