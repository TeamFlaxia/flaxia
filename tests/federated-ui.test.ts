// Behavioural guards for the Federated tab: navigation, titles, the ranked
// API, and the rendered page. The page is a thin shell over the card host, so
// these tests exercise the real route module and a real client-side mount
// instead of pattern-matching source text.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import type { User } from '../functions/lib/auth.ts';
import { navItemsFor } from '../src/lib/nav-items.ts';
import { pageDescription, pageTitle } from '../src/lib/page-title.ts';
import { parseRoute } from '../src/lib/router.ts';
import { viewToBottomNavId } from '../src/lib/view-nav.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ROOT = new URL('..', import.meta.url).pathname;

// Node cannot load .svelte files, and Svelte's package exports resolve to the
// server entry under Node conditions. This resolver compiles .svelte modules
// to Svelte's client runtime on the fly so the components can be mounted in a
// happy-dom document; app-only imports are stubbed because they need a live
// SvelteKit runtime. It also lets the aggregate Hono app resolve the
// extensionless/directory imports its Worker bundler uses.
const loader = `
import { readFileSync } from 'node:fs';
import { compile } from 'file://${ROOT}/node_modules/svelte/src/compiler/index.js';
const CLIENT_SVELTE = 'file://${ROOT}/node_modules/svelte/src/index-client.js';
const STUB_APP = 'data:text/javascript,' + encodeURIComponent([
  "export const goto = async (url) => { globalThis.__GOTO__ ??= []; globalThis.__GOTO__.push(url); };",
  "export const preloadCode = async () => {};",
  "export const preloadData = async () => {};",
  "export const invalidateAll = async () => {};",
  "export const page = globalThis.__PAGE__ ?? {};",
  "export const browser = false;",
  "export const dev = false;",
  "export const env = {};",
].join('\\n'));
const STUB_POST_TYPES = 'data:text/javascript,' + encodeURIComponent('export const PostCardMode = { PREVIEW: "preview", EXECUTING: "executing" }; export const isAd = () => false;');
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('$app/')) return { url: STUB_APP, shortCircuit: true };
  if (specifier === 'svelte') return { url: CLIENT_SVELTE, shortCircuit: true };
  if (specifier === 'svelte/legacy') return { url: 'file://${ROOT}/node_modules/svelte/src/legacy/legacy-client.js', shortCircuit: true };
  if (specifier === 'svelte/store') return { url: 'file://${ROOT}/node_modules/svelte/src/store/index-client.js', shortCircuit: true };
  if (specifier === 'svelte/reactivity') return { url: 'file://${ROOT}/node_modules/svelte/src/reactivity/index-client.js', shortCircuit: true };
  if (specifier.includes('shared/types/post.ts')) return { url: STUB_POST_TYPES, shortCircuit: true };
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if ((error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') && specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      try { return await nextResolve(specifier + '.ts', context); } catch (inner) {
        if (inner.code === 'ERR_MODULE_NOT_FOUND' || inner.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return nextResolve(specifier + '/index.ts', context);
        throw inner;
      }
    }
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    throw error;
  }
}
export async function load(url, context, nextLoad) {
  if (url.endsWith('.svelte')) {
    const source = readFileSync(new URL(url), 'utf8');
    const { js } = compile(source, { filename: url, generate: 'client', dev: false });
    return { format: 'module', source: js.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(loader));

const { handleApi } = await import('../functions/api/[[route]].ts');
const federatedRoute = (await import('../functions/api/routes/federated.ts')).default;

type AppEnv = { Bindings: Bindings; Variables: Variables };
type Client = {
  mount: (component: unknown, options: { target: Element; props: Record<string, unknown> }) => unknown;
  unmount: (instance: unknown) => void;
};

const client = (await import(pathToFileURL(join(ROOT, 'node_modules/svelte/src/index-client.js')).href)) as Client;

const win = new Window({ url: 'https://flaxia.test/' });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
for (const key of Object.getOwnPropertyNames(win)) {
  if (key in globals) continue;
  try {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  } catch {}
}
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);

const originalFetch = globalThis.fetch;
const originalObserver = globals.IntersectionObserver;

after(() => {
  globalThis.fetch = originalFetch;
  globals.IntersectionObserver = originalObserver;
});

/** Mount a real Svelte component and return its root plus a disposer. */
async function mountPage(path: string, props: Record<string, unknown>): Promise<{ root: Element; done: () => void }> {
  const module = (await import(pathToFileURL(join(ROOT, path)).href)) as { default: unknown };
  const root = win.document.createElement('div');
  win.document.body.append(root);
  const instance = client.mount(module.default, { target: root, props });
  return {
    root,
    done: () => {
      client.unmount(instance);
      root.remove();
    },
  };
}

function stubFetch(handler: (url: string) => { posts: unknown[]; next_cursor?: string | null } | Error): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const result = handler(url);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return urls;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function text(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '');
}

// --- API fixtures ---------------------------------------------------------

type AllResult<T> = { results: T[]; success: boolean };
type Statement = ReturnType<TestDatabase['prepare']>;

function wrapStatement(statement: Statement): Statement {
  return {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
    first: <T>() => statement.first<T>(),
    all: async <T>() => ({ ...(await statement.all<T>()), success: true }) as AllResult<T> as { results: T[] },
    run: () => statement.run(),
  };
}

function wrapDb(database: TestDatabase): TestDatabase {
  return {
    prepare: (sql: string) => wrapStatement(database.prepare(sql)),
    batch: (statements: Statement[]) => database.batch(statements),
    exec: (sql: string) => database.exec(sql),
    close: () => database.close(),
  };
}

const NOW = '2026-11-26T00:00:00.000Z';
const VIEWER: User = {
  id: 'viewer',
  email: 'viewer@test.com',
  username: 'viewer',
  display_name: 'Viewer',
  bio: '',
  created_at: NOW,
};

const databases: TestDatabase[] = [];

function freshDb(): { db: TestDatabase; env: Bindings } {
  const db = createTestDatabase();
  databases.push(db);
  db.prepare('DELETE FROM posts').run();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, username, display_name, bio, created_at)
     VALUES (?, ?, '', ?, ?, '', ?)`,
  )
    .bind(VIEWER.id, VIEWER.email, VIEWER.username, VIEWER.display_name, NOW)
    .run();
  return { db, env: { DB: wrapDb(db) as unknown as Bindings['DB'], BASE_URL: 'https://flaxia.app' } as Bindings };
}

function seedPoolPost(db: TestDatabase, id: string, score: number, createdAt: string): void {
  db.prepare(
    `INSERT INTO posts (id, user_id, username, text, hashtags, status, created_at, actor_id, visibility)
     VALUES (?, '', ?, ?, '[]', 'published', ?, ?, 'public')`,
  )
    .bind(id, id, `post ${id}`, createdAt, `https://remote.example/${id}`)
    .run();
  db.prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, ?, ?)')
    .bind(id, 'remote.example', score, createdAt)
    .run();
}

after(() => {
  for (const db of databases) db.close();
});

describe('federated navigation and routing', () => {
  it('exposes a public Federated item in both rails', () => {
    for (const signedIn of [false, true]) {
      const item = navItemsFor(signedIn).find((entry) => entry.id === 'federated');
      assert.ok(item, `federated missing from ${signedIn ? 'signed-in' : 'guest'} rail`);
      assert.equal(item.labelKey, 'nav.federated');
      assert.equal(item.icon, 'explore');
    }
  });

  it('parses /federated as its own view and highlights the discovery tab', () => {
    assert.equal(parseRoute('/federated', '')?.view, 'federated');
    assert.equal(parseRoute('/federated/', '')?.view, 'federated');
    assert.equal(viewToBottomNavId('federated'), 'explore');
  });

  it('titles the Federated route and keeps remote-profile titles instance-aware', () => {
    assert.equal(pageTitle('/federated'), 'Flaxia - federated.title');
    assert.equal(pageTitle('/federated/'), 'Flaxia - federated.title');
    assert.equal(pageTitle('/@remote.example/alice'), 'Flaxia - remote_profile.title · @alice@remote.example');
    assert.equal(pageTitle('/profile/alice'), 'Flaxia - nav.profile · @alice');
    assert.equal(pageDescription('/federated'), 'federated.subtitle');
    assert.equal(pageDescription('/federated/'), 'federated.subtitle');
    assert.equal(pageDescription('/@remote.example/alice'), 'site.description');
  });
});

describe('rendered FederatedPage', () => {
  before(() => {
    globals.IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it('renders the ranked response in server order with the discovery copy', async () => {
    const posts = [
      {
        id: 'low-new',
        user_id: '',
        username: 'new',
        display_name: 'New',
        text: 'newer, lower score',
        created_at: NOW,
        hashtags: '[]',
        mentions: '[]',
        actor_id: 'https://remote.example/new',
      },
      {
        id: 'high-old',
        user_id: '',
        username: 'old',
        display_name: 'Old',
        text: 'older, higher score',
        created_at: '2026-11-20T00:00:00.000Z',
        hashtags: '[]',
        mentions: '[]',
        actor_id: 'https://remote.example/old',
      },
    ];
    const urls = stubFetch(() => ({ posts, next_cursor: null }));
    const page = await mountPage('src/lib/svelte/FederatedPage.svelte', {
      sandboxOrigin: 'https://sandbox.flaxia.app',
      currentUser: null,
    });
    try {
      await tick();
      assert.deepEqual(urls, ['/api/federated/posts?limit=20'], 'the page loads the ranked API');
      // The response deliberately reverses both score and chronological order:
      // the rendered order must be exactly the order the server returned.
      assert.deepEqual(text(page.root, '.post-text'), ['newer, lower score', 'older, higher score']);
      assert.equal(page.root.querySelector('.page-header-title')?.textContent?.trim(), 'federated.title');
      assert.equal(
        page.root.querySelector('.federated-popular-badge')?.getAttribute('aria-label'),
        'federated.popular_label',
      );
      assert.equal(page.root.querySelector('.federated-hide-hint')?.textContent?.trim(), 'federated.hide_hint');
    } finally {
      page.done();
    }
  });

  it('shows the empty and load-failure states from real responses', async () => {
    stubFetch(() => ({ posts: [], next_cursor: null }));
    const empty = await mountPage('src/lib/svelte/FederatedPage.svelte', {
      sandboxOrigin: 'https://sandbox.flaxia.app',
      currentUser: null,
    });
    try {
      await tick();
      assert.equal(empty.root.querySelector('.timeline-empty-title')?.textContent?.trim(), 'federated.empty');
    } finally {
      empty.done();
    }

    stubFetch(() => new Error('offline'));
    const failed = await mountPage('src/lib/svelte/FederatedPage.svelte', {
      sandboxOrigin: 'https://sandbox.flaxia.app',
      currentUser: null,
    });
    try {
      await tick();
      assert.equal(failed.root.querySelector('[role="alert"]')?.textContent?.includes('federated.load_failed'), true);
    } finally {
      failed.done();
    }
  });

  it('requests the opaque cursor on Load more and appends without reordering', async () => {
    const first = {
      id: 'first',
      user_id: '',
      username: 'a',
      display_name: 'A',
      text: 'first',
      created_at: NOW,
      hashtags: '[]',
      mentions: '[]',
      actor_id: 'https://remote.example/a',
    };
    const second = {
      id: 'second',
      user_id: '',
      username: 'b',
      display_name: 'B',
      text: 'second',
      created_at: '2026-11-20T00:00:00.000Z',
      hashtags: '[]',
      mentions: '[]',
      actor_id: 'https://remote.example/b',
    };
    const urls = stubFetch((url) =>
      url.includes('cursor=')
        ? { posts: [second], next_cursor: null }
        : { posts: [first], next_cursor: '7,2026-11-26T00:00:00.000Z,first' },
    );
    const page = await mountPage('src/lib/svelte/FederatedPage.svelte', {
      sandboxOrigin: 'https://sandbox.flaxia.app',
      currentUser: null,
    });
    try {
      await tick();
      const button = page.root.querySelector('.load-more-btn') as HTMLButtonElement;
      assert.equal(button.disabled, false, 'a next cursor enables Load more');
      button.click();
      await tick();
      assert.deepEqual(urls[1], '/api/federated/posts?limit=20&cursor=7%2C2026-11-26T00%3A00%3A00.000Z%2Cfirst');
      assert.deepEqual(text(page.root, '.post-text'), ['first', 'second']);
    } finally {
      page.done();
    }
  });
});

describe('GET /api/federated/posts', () => {
  async function get(
    path: string,
    env: Bindings,
    viewer: User | null = null,
  ): Promise<{ status: number; ids: string[] }> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      if (viewer) c.set('user', viewer);
      await next();
    });
    app.route('/', federatedRoute);
    const response = await app.request(`http://localhost${path}`, {}, env);
    assert.equal(response.status, 200, `${path} → ${response.status}: ${await response.clone().text()}`);
    const data = (await response.json()) as { posts: Array<{ id: string }> };
    return { status: response.status, ids: data.posts.map((post) => post.id) };
  }

  it('ranks by pool score, not by creation time, and paginates by exact id', async () => {
    const { db, env } = freshDb();
    seedPoolPost(db, 'low-score-new', 1, NOW);
    seedPoolPost(db, 'high-score-old', 9, '2026-11-20T00:00:00.000Z');
    seedPoolPost(db, 'mid-score', 5, '2026-11-25T00:00:00.000Z');

    assert.deepEqual((await get('/federated/posts?limit=10', env)).ids, [
      'high-score-old',
      'mid-score',
      'low-score-new',
    ]);
    const firstPage = await get('/federated/posts?limit=1', env);
    assert.deepEqual(firstPage.ids, ['high-score-old']);
    const secondPage = await get(
      '/federated/posts?limit=1&cursor=9%2C2026-11-20T00%3A00%3A00.000Z%2Chigh-score-old',
      env,
    );
    assert.deepEqual(secondPage.ids, ['mid-score']);
  });

  it('applies the viewer’s blocks to the ranked pool', async () => {
    const { db, env } = freshDb();
    seedPoolPost(db, 'allowed', 5, NOW);
    seedPoolPost(db, 'blocked', 8, NOW);
    db.prepare('INSERT INTO ap_blocks (local_user_id, actor_url) VALUES (?, ?)')
      .bind(VIEWER.id, 'https://remote.example/blocked')
      .run();

    assert.deepEqual((await get('/federated/posts?limit=10', env)).ids, ['blocked', 'allowed']);
    assert.deepEqual((await get('/federated/posts?limit=10', env, VIEWER)).ids, ['allowed']);
  });

  it('is mounted on the aggregate API alongside the existing routers', async () => {
    const { db, env } = freshDb();
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    async function api(path: string): Promise<{ status: number; ids: string[] }> {
      const response = await handleApi(new Request(`http://localhost${path}`), env, ctx);
      const body = (await response.json()) as { posts?: Array<{ id: string }>; results?: Array<{ id: string }> };
      return { status: response.status, ids: (body.posts ?? body.results ?? []).map((post) => post.id) };
    }
    const onlyPost = {
      id: 'public-1',
      user_id: 'viewer',
      username: 'viewer',
      text: 'a federated and searchable note',
      hashtags: '[]',
      status: 'published',
      created_at: NOW,
      visibility: 'public',
    };
    db.prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, status, created_at, actor_id, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        onlyPost.id,
        onlyPost.user_id,
        onlyPost.username,
        onlyPost.text,
        onlyPost.hashtags,
        onlyPost.status,
        onlyPost.created_at,
        'https://remote.example/viewer',
        onlyPost.visibility,
      )
      .run();
    db.prepare('INSERT INTO ap_pool_metrics (post_id, instance, score, fetched_at) VALUES (?, ?, ?, ?)')
      .bind(onlyPost.id, 'remote.example', 4, NOW)
      .run();

    assert.deepEqual(await api('/api/federated/posts?limit=5'), { status: 200, ids: ['public-1'] });
    const feed = await api('/api/posts?limit=5');
    assert.equal(feed.status, 200);
    assert.ok(feed.ids.includes('public-1'), 'the posts router is still mounted');
    const search = await api('/api/search?q=federated');
    assert.equal(search.status, 200);
    assert.ok(search.ids.includes('public-1'), 'the search router is still mounted');
  });
});

describe('federated locale strings', () => {
  it('ships the same keys in English and Japanese', async () => {
    const en = JSON.parse(await read('public/locales/en.json')) as Record<string, string>;
    const ja = JSON.parse(await read('public/locales/ja.json')) as Record<string, string>;
    for (const key of [
      'nav.federated',
      'federated.title',
      'federated.subtitle',
      'federated.empty',
      'federated.load_failed',
      'federated.popular_label',
      'federated.hide_hint',
    ] as const) {
      assert.ok(typeof en[key] === 'string' && en[key].length > 0, `${key} missing from en.json`);
      assert.ok(typeof ja[key] === 'string' && ja[key].length > 0, `${key} missing from ja.json`);
    }
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  });
});
