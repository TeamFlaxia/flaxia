// PR 512 review fixes, exercised through real components/load functions:
// nested-button keyboard activation on remote search results, per-viewer follow
// state seeding, generic share metadata on /federated, and strict remote
// username validation in the SSR load.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { Window } from 'happy-dom';
import { render } from 'svelte/server';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = new URL('..', import.meta.url).pathname;

// Mirror the harness in remote-profile-ui.test.ts: compile .svelte files for
// Svelte's client runtime and stub $app modules that need a live SvelteKit.
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

const client = (await import(pathToFileURL(join(ROOT, 'node_modules/svelte/src/index-client.js')).href)) as {
  mount: (component: unknown, options: { target: Element; props: Record<string, unknown> }) => unknown;
  unmount: (instance: unknown) => void;
};

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
globals.Event = win.Event;
globals.CustomEvent = win.CustomEvent;
globals.MouseEvent = win.MouseEvent;
globals.KeyboardEvent = win.KeyboardEvent;

const originalFetch = globalThis.fetch;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  globalThis.fetch = originalFetch;
  globals.__GOTO__ = [];
  globals.__PAGE__ = undefined;
});

const LOOKUP_RESULT = {
  handle: '@bob@remote.example',
  displayName: 'Bob',
  avatarUrl: null,
  actorUrl: 'https://remote.example/users/bob',
  domain: 'remote.example',
};

type FollowCall = { url: string; method: string };

async function mountSearch(
  followState: string | null,
  followResponse: { status: number; body: unknown },
): Promise<{ root: Element; calls: FollowCall[]; done: () => void }> {
  const calls: FollowCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/remote/lookup?q=')) return json(LOOKUP_RESULT);
    if (url.startsWith('/api/remote/actors/')) {
      return json({
        actor: { actor_url: LOOKUP_RESULT.actorUrl, display_name: 'Bob', icon_url: null },
        following: followState === 'accepted',
        follow_state: followState,
        posts: [],
      });
    }
    if (url === '/api/remote-follow') return json(followResponse.body, followResponse.status);
    return json({ posts: [], users: [], games: [], web: [] });
  }) as typeof fetch;

  const module = (await import(pathToFileURL(join(ROOT, 'src/lib/svelte/SearchPage.svelte')).href)) as {
    default: unknown;
  };
  const root = win.document.createElement('div');
  win.document.body.append(root);
  const instance = client.mount(module.default, {
    target: root,
    props: {
      query: '@bob@remote.example',
      type: 'users',
      currentUser: { username: 'alice' },
      sandboxOrigin: 'https://sandbox.flaxia.app',
    },
  });
  await tick();
  await tick();
  assert.ok(root.querySelector('.remote-user-row'), 'the remote result must be rendered');
  return {
    root,
    calls,
    done: () => {
      client.unmount(instance);
      root.remove();
    },
  };
}

describe('remote search result follow state', () => {
  it('seeds an accepted follow from the actor profile and unfollows with DELETE', async () => {
    const page = await mountSearch('accepted', { status: 200, body: { success: true } });
    try {
      const button = page.root.querySelector('.remote-follow-button');
      assert.equal(button?.textContent?.trim(), 'search.remote_following');
      button?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      const follow = page.calls.find((call) => call.url === '/api/remote-follow');
      assert.equal(follow?.method, 'DELETE', 'an already-followed account must unfollow, not POST again');
    } finally {
      page.done();
    }
  });

  it('shows a sent follow as pending in search results', async () => {
    const page = await mountSearch('sent', { status: 200, body: { status: 'pending' } });
    try {
      assert.equal(
        page.root.querySelector('.remote-follow-button')?.textContent?.trim(),
        'search.remote_follow_pending',
      );
    } finally {
      page.done();
    }
  });

  it('treats a duplicate follow 409 as already following instead of an error', async () => {
    const page = await mountSearch(null, { status: 409, body: { error: 'Already following this user' } });
    try {
      assert.equal(page.root.querySelector('.remote-follow-button')?.textContent?.trim(), 'search.remote_follow');
      page.root.querySelector('.remote-follow-button')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.equal(page.root.querySelector('.remote-follow-button')?.textContent?.trim(), 'search.remote_following');
      assert.equal(win.document.querySelectorAll('[role="alert"]').length, 0, 'no error toast for a 409');
    } finally {
      page.done();
    }
  });

  it('keeps Enter on the nested follow button from navigating away', async () => {
    const page = await mountSearch(null, { status: 200, body: { status: 'pending' } });
    try {
      const button = page.root.querySelector('.remote-follow-button');
      button?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      assert.deepEqual(globals.__GOTO__, [], 'the row handler must ignore keys from its nested button');
      assert.equal(
        page.calls.some((call) => call.url === '/api/remote-follow'),
        false,
      );

      // Space has the same problem: the row handled it unconditionally too.
      button?.dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await tick();
      assert.deepEqual(globals.__GOTO__, []);

      // Activation of the button itself still toggles follow state.
      button?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.equal(
        page.calls.some((call) => call.url === '/api/remote-follow'),
        true,
      );

      // Enter on the row (the actual target) still opens the remote profile.
      page.root
        .querySelector('.remote-user-row')
        ?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      assert.deepEqual(globals.__GOTO__, ['/@remote.example/bob']);
    } finally {
      page.done();
    }
  });
});

// --- SSR head and load validation -----------------------------------------

const appStub = {
  name: 'app-state-stub',
  enforce: 'pre' as const,
  resolveId(id: string) {
    return id.startsWith('$app/') ? `\0stub:${id}` : null;
  },
  load(id: string) {
    if (!id.startsWith('\0stub:')) return null;
    const module = id.slice(6);
    if (module === '$app/navigation') {
      return `export const goto = async () => {}; export const preloadCode = async () => {}; export const preloadData = async () => {}; export const beforeNavigate = () => {}; export const afterNavigate = () => {};`;
    }
    if (module === '$app/state') {
      return `export const page = new Proxy({}, { get: (_, key) => globalThis.__PAGE__?.[key] });`;
    }
    return `export default {};`;
  },
};

async function withVite<T>(run: (server: ViteDevServer) => Promise<T>): Promise<T> {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    plugins: [appStub, svelte({ compilerOptions: { dev: false } })],
    resolve: { conditions: ['node'] },
  });
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function metaContent(head: string, attribute: 'name' | 'property', key: string): string | null {
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`${attribute}=["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

describe('federated SSR head', () => {
  it('emits the generic title, canonical, Open Graph, Twitter and JSON-LD tags exactly once', async () => {
    await withVite(async (server) => {
      const layout = (await server.ssrLoadModule('/src/routes/+layout.svelte')).default;
      globals.__PAGE__ = {
        status: 200,
        params: {},
        data: {},
        route: { id: '/federated' },
        url: new URL('https://flaxia.app/federated'),
      };
      const head = render(layout as never, { props: { children: () => 'children' } }).head;
      assert.match(head, /<title>/);
      assert.equal(metaContent(head, 'property', 'og:title'), 'Flaxia - federated.title');
      assert.equal(metaContent(head, 'property', 'og:url'), 'https://flaxia.app/federated');
      assert.equal(metaContent(head, 'name', 'twitter:card'), 'summary_large_image');
      assert.match(head, /application\/ld\+json/);
      assert.equal(head.match(/<meta\b[^>]*name=["']description["']/gi)?.length ?? 0, 1);
      assert.equal(
        head.match(/<meta\b[^>]*property=["']og:description["']/gi)?.length ?? 0,
        1,
        'the page and layout must not emit duplicate OG descriptions',
      );
    });
  });
});

describe('remote profile username validation', () => {
  it('404s crafted usernames containing @ before any lookup request', async () => {
    await withVite(async (server) => {
      const load = (
        (await server.ssrLoadModule('/src/routes/@[domain]/[username]/+page.ts')) as {
          load: (args: Record<string, unknown>) => Promise<unknown>;
        }
      ).load;
      let calls = 0;
      const fetchFn = (async () => {
        calls++;
        return new Response(JSON.stringify({ actor: null }), { status: 200 });
      }) as typeof fetch;
      for (const username of ['bob@example.com', 'bob%40example.com', 'bob@', '@bob', 'bob/evil']) {
        await assert.rejects(
          load({ fetch: fetchFn, params: { domain: 'remote.example', username }, setHeaders: () => {} }),
          (error: unknown) => (error as { status?: number }).status === 404,
          username,
        );
      }
      assert.equal(calls, 0, 'invalid usernames must not reach the API');
    });
  });

  it('still loads ordinary usernames', async () => {
    await withVite(async (server) => {
      const load = (
        (await server.ssrLoadModule('/src/routes/@[domain]/[username]/+page.ts')) as {
          load: (args: Record<string, unknown>) => Promise<{ profile: unknown }>;
        }
      ).load;
      const profile = { actor: { actor_url: 'https://remote.example/users/bob' }, posts: [] };
      const result = await load({
        fetch: (async () => new Response(JSON.stringify(profile), { status: 200 })) as typeof fetch,
        params: { domain: 'remote.example', username: 'bob_123' },
        setHeaders: () => {},
      });
      assert.deepEqual(result, { profile });
    });
  });
});
