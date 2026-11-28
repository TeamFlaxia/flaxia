// P3 correctness/accessibility guards for remote profiles, the composer and
// federated author links. These are behavioural tests: route `load()` is
// executed with a stub fetch, Svelte components are compiled and server-rendered
// (or client-mounted in happy-dom), and CSS is evaluated through getComputedStyle.
// No assertions are made against component source text.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import * as svelteCompiler from 'svelte/compiler';
import { render } from 'svelte/server';
import { enrichPostsWithRemoteAuthors } from '../functions/lib/activitypub/authors.ts';
import type { Db } from '../functions/lib/ports/index.ts';
import { setLocaleResolver } from '../src/lib/i18n.ts';

const { compile } = svelteCompiler as unknown as {
  compile: (
    source: string,
    options: { filename: string; generate: 'server' | 'client'; dev?: boolean },
  ) => {
    js: { code: string };
  };
};
assert.equal(typeof compile, 'function', 'svelte compiler must be available for SSR assertions');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = '/tmp/opencode/flaxia-p3-tests';
let fileCounter = 0;

const en = JSON.parse(await readFile(join(ROOT, 'public/locales/en.json'), 'utf8')) as Record<string, string>;

const navCalls: string[] = [];
const openCalls: string[] = [];

async function tempFile(extension: string, body: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const path = join(TMP, `p3-${++fileCounter}.${extension}`);
  await writeFile(path, body);
  return path;
}

async function stubModule(name: string, body: string): Promise<string> {
  const path = join(TMP, `${name}.mjs`);
  await mkdir(TMP, { recursive: true });
  await writeFile(path, body);
  return pathToFileURL(path).href;
}

const navigationStub = await stubModule(
  'navigation-stub',
  `export function navigate(url) { globalThis.__P3_NAV__.push(url); return Promise.resolve(); }\n` +
    `export function navigateReplace(url) { return navigate(url); }\n` +
    `export function preloadCode() { return Promise.resolve(); }\n` +
    `export function preloadData() { return Promise.resolve(); }\n`,
);
const appStateStub = await stubModule(
  'app-state-stub',
  `export const page = new Proxy({}, { get: (_t, key) => globalThis.__P3_PAGE__?.[key] });\n`,
);
const emptyStub = await stubModule('empty-stub', `export const page = {};\n`);

async function namedStub(name: string, exports: string[]): Promise<string> {
  return stubModule(`${name}-stub`, exports.map((fn) => `export function ${fn}() {}`).join('\n') + '\n');
}

const nameColorStub = await namedStub('name-color', ['applyNameColor']);
const avatarStub = await namedStub('avatar', ['attachPlusBadge']);
const badgeStub = await namedStub('badge', ['mountTitleBadge']);
const offlineImageStub = await namedStub('offline-image', ['setOfflineImage']);
const filePreviewStub = await namedStub('file-preview', [
  'checkImageSizeLimit',
  'detectAttachKind',
  'renderFilePreview',
]);
const mediaListStub = await namedStub('media-list', ['mountMediaList']);
const toastStub = await namedStub('toast', ['showToast']);
const stampPickerStub = await namedStub('stamp-picker', ['openStampPicker']);
const vaultSessionStub = await namedStub('vault-session', [
  'getVaultKey',
  'isVaultUnlocked',
  'subscribeVault',
  'tryDeviceUnlock',
]);
const vaultItemsStub = await namedStub('vault-items', [
  'deleteVaultItem',
  'deleteVaultItems',
  'listVaultItems',
  'newVaultItemId',
  'saveVaultItem',
]);

function mapSpecifier(spec: string, fromFile: string, extra: Record<string, string>): string {
  if (extra[spec]) return extra[spec];
  if (spec === '$app/navigation') return navigationStub;
  if (spec === '$app/state') return appStateStub;
  if (spec.startsWith('$app/')) return emptyStub;
  if (spec.startsWith('.')) return pathToFileURL(resolve(dirname(fromFile), spec)).href;
  return import.meta.resolve(spec);
}

/** Rewrite module specifiers only; the compiled logic is executed unchanged. */
function rewriteSpecifiers(code: string, fromFile: string, extra: Record<string, string>): string {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\2/g, (whole, prefix, quote, spec) => {
    const mapped = mapSpecifier(String(spec), fromFile, extra);
    return mapped === spec ? whole : `${prefix}${quote}${mapped}${quote}`;
  });
}

async function compileModule(relPath: string, extra: Record<string, string> = {}): Promise<{ default: unknown }> {
  const abs = join(ROOT, relPath);
  const source = await readFile(abs, 'utf8');
  const { js } = compile(source, { filename: abs, generate: 'server' });
  const path = await tempFile('mjs', rewriteSpecifiers(js.code, abs, extra));
  return import(pathToFileURL(path).href) as Promise<{ default: unknown }>;
}

async function compileStub(source: string): Promise<string> {
  const abs = join(TMP, `stub-${++fileCounter}.svelte`);
  const { js } = compile(source, { filename: abs, generate: 'server' });
  return pathToFileURL(await tempFile('mjs', rewriteSpecifiers(js.code, abs, {}))).href;
}

const shellStub = await compileStub(`<script lang="ts">let { children } = $props();</script>{@render children?.()}`);
const slotStub = await compileStub(`<script lang="ts">let { children } = $props();</script>{@render children?.()}`);
const viewStub = await compileStub(`<div data-stub-view></div>`);

type Renderable = Parameters<typeof render>[0];
const renderHtml = (component: Renderable, props: Record<string, unknown>): string => {
  const result = render(component, { props });
  return String(result.body) + String(result.head);
};

const profileProps = (overrides: Record<string, unknown> = {}) => ({
  domain: 'remote.example',
  username: 'bob',
  currentUser: { username: 'alice' },
  initialProfile: {
    actor: {
      actor_url: 'https://remote.example/users/bob',
      display_name: 'Bob',
      icon_url: null as string | null,
      bio: 'hello',
    },
    following: false,
    follow_state: null as string | null,
    posts: [],
  },
  ...overrides,
});

before(() => {
  globalThis.__P3_NAV__ = navCalls;
  globalThis.__P3_OPEN__ = openCalls;
  globalThis.__P3_PAGE__ = { params: { domain: 'remote.example', username: 'bob' } };
  setLocaleResolver(() => ({ locale: 'en', strings: en, fallback: en }));
});

after(() => {
  setLocaleResolver(null);
  delete (globalThis as Record<string, unknown>).__P3_NAV__;
  delete (globalThis as Record<string, unknown>).__P3_OPEN__;
  delete (globalThis as Record<string, unknown>).__P3_PAGE__;
});

describe('remote profile route domain normalization', () => {
  async function loadRoute() {
    const abs = join(ROOT, 'src/routes/@[domain]/[username]/+page.ts');
    const source = await readFile(abs, 'utf8');
    // Vite injects import.meta.env; shim it so the real load() runs in Node.
    const shimmed = source.replace(/\bimport\.meta\.env\b/g, '({ BUILD_TARGET: "web" })');
    const path = await tempFile('ts', rewriteSpecifiers(shimmed, abs, {}));
    return import(pathToFileURL(path).href) as Promise<{
      load: (args: {
        fetch: typeof fetch;
        params: Record<string, string>;
        setHeaders: (headers: Record<string, string>) => void;
      }) => Promise<{ profile: unknown }>;
    }>;
  }

  const okFetch = (paths: string[]): typeof fetch =>
    (async (input: string | URL | Request) => {
      paths.push(String(input));
      return new Response(JSON.stringify({ actor: { actor_url: 'https://remote.example/users/bob' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

  it('redirects a mixed-case domain to one lowercase canonical route', async () => {
    const { load } = await loadRoute();
    const paths: string[] = [];
    let headers: Record<string, string> = {};
    await assert.rejects(
      load({
        fetch: okFetch(paths),
        params: { domain: 'MASTODON.SOCIAL', username: 'Bob' },
        setHeaders: (h) => {
          headers = h;
        },
      }),
      (err: { status?: number; location?: string }) => {
        assert.equal(err.status, 308);
        assert.equal(err.location, '/@mastodon.social/Bob');
        return true;
      },
    );
    assert.deepEqual(paths, [], 'must not fetch before redirecting to the canonical route');
    assert.equal(headers['Cache-Control'], 'private, no-store');
  });

  it('loads the canonical lowercase domain and keeps per-viewer no-store headers', async () => {
    const { load } = await loadRoute();
    const paths: string[] = [];
    let headers: Record<string, string> = {};
    const data = await load({
      fetch: okFetch(paths),
      params: { domain: 'mastodon.social', username: 'Bob' },
      setHeaders: (h) => {
        headers = h;
      },
    });
    assert.deepEqual(paths, ['/api/remote/actors/mastodon.social/Bob']);
    assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.equal(
      (data.profile as { actor: { actor_url: string } }).actor.actor_url,
      'https://remote.example/users/bob',
    );
  });

  it('renders a single canonical URL even when the route param is mixed-case', async () => {
    const component = await compileModule('src/routes/@[domain]/[username]/+page.svelte', {
      '../../../lib/svelte/ShellLayout.svelte': shellStub,
      '../../../lib/svelte/SsrOnly.svelte': slotStub,
      '../../../lib/svelte/RemoteProfilePage.svelte': viewStub,
    });
    (globalThis as Record<string, unknown>).__P3_PAGE__ = {
      params: { domain: 'MASTODON.SOCIAL', username: 'Bob' },
    };
    const html = renderHtml(component.default as Renderable, {
      data: { profile: { actor: { display_name: 'Bob', bio: 'hi' }, posts: [] } },
    });
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const ogUrl = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1];
    assert.equal(canonical, 'https://flaxia.app/@mastodon.social/Bob');
    assert.equal(ogUrl, canonical, 'og:url must match the canonical URL');
    assert.ok(html.includes('@Bob@mastodon.social'), 'the rendered handle must use the normalized domain');
    assert.doesNotMatch(html, /MASTODON\.SOCIAL/, 'no mixed-case domain variant may leak into metadata');
  });
});

describe('federated author profile links', () => {
  function fakeDb(
    postActors: Record<string, string>,
    actorRows: Array<Record<string, unknown>> = [],
  ): { db: Db; queries: string[] } {
    const queries: string[] = [];
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        let values: unknown[] = [];
        const statement = {
          bind(...bound: unknown[]) {
            values = bound;
            return statement;
          },
          async all<T>() {
            if (sql.includes('FROM posts')) {
              return {
                results: values.map((id) => ({ id, actor_id: postActors[String(id)] ?? null })),
                success: true,
              } as { results: T[]; success: boolean };
            }
            return { results: actorRows as T[], success: true };
          },
          async first<T>() {
            return (actorRows[0] as T) ?? null;
          },
          async run() {
            return { results: [], success: true };
          },
          async raw<T>() {
            return [] as T[];
          },
        };
        return statement;
      },
      async batch() {
        return [];
      },
      async exec() {
        return { count: 0, duration: 0 };
      },
    } as unknown as Db;
    return { db, queries };
  }

  it('does not create an internal profile path when no domain can be derived', async () => {
    const { db } = fakeDb({ p1: 'urn:unknown-actor' });
    const post: Record<string, unknown> = { id: 'p1' };
    await enrichPostsWithRemoteAuthors([post], db);
    assert.equal(post.actor_id, 'urn:unknown-actor');
    assert.equal(post.profile_path, undefined, 'an encoded actor URL is not a valid /@domain/user path');
  });

  it('keeps the internal path for actors whose domain is derivable', async () => {
    const { db } = fakeDb({ p2: 'https://remote.example/users/bob' });
    const post: Record<string, unknown> = { id: 'p2' };
    await enrichPostsWithRemoteAuthors([post], db);
    assert.equal(post.profile_path, '/@remote.example/bob');
  });

  const headerStubs = {
    '../../../shared/name-color.ts': nameColorStub,
    '../avatar.ts': avatarStub,
    '../post/header-badge.ts': badgeStub,
    '../navigation.ts': navigationStub,
    '../offline-image.ts': offlineImageStub,
  };

  it('opens the external actor URL when the internal path is missing', async () => {
    const window = await mountClient('src/lib/svelte/PostHeader.svelte', headerStubs, {
      username: 'urn:unknown-actor',
      display_name: 'Bob',
      profile_url: 'https://remote.example/users/bob',
      profile_path: null,
      createdAt: new Date().toISOString(),
    });
    openCalls.length = 0;
    navCalls.length = 0;
    window.document
      .querySelector('.post-display-name')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(navCalls, [], 'must not navigate to an invalid internal path');
    assert.deepEqual(openCalls, ['https://remote.example/users/bob']);
    window.happyDOM.cancelAsync();
  });

  it('ignores non-http external URLs and falls back to the local profile', async () => {
    const window = await mountClient('src/lib/svelte/PostHeader.svelte', headerStubs, {
      username: 'bob',
      display_name: 'Bob',
      profile_url: 'javascript:alert(1)',
      profile_path: '/@https%3A%2F%2Fremote.example%2Fusers%2Fbob/',
      createdAt: new Date().toISOString(),
    });
    openCalls.length = 0;
    navCalls.length = 0;
    window.document
      .querySelector('.post-display-name')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(openCalls, []);
    assert.deepEqual(navCalls, ['/profile/bob']);
    window.happyDOM.cancelAsync();
  });
});

/** Compile a component for the browser and mount it into happy-dom. */
async function mountClient(
  relPath: string,
  extra: Record<string, string>,
  props: Record<string, unknown>,
): Promise<Window & typeof globalThis> {
  const window = new Window({ url: 'https://flaxia.app' });
  window.open = ((url: string) => {
    openCalls.push(url);
    return null;
  }) as typeof window.open;
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'Element',
    'HTMLElement',
    'SVGElement',
    'Node',
    'Text',
    'Comment',
    'DocumentFragment',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'Image',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    const value =
      (window as unknown as Record<string, unknown>)[key] ??
      (window.document as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'navigator') {
      Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
  const abs = join(ROOT, relPath);
  const source = await readFile(abs, 'utf8');
  const { js } = compile(source, { filename: abs, generate: 'client' });
  const path = await tempFile('mjs', rewriteSpecifiers(js.code, abs, extra));
  const clientModule = (await import(pathToFileURL(path).href)) as { default: unknown };
  // Node resolves the `svelte` package to its server build; mount() only
  // exists in the browser entry, so import that entry by path.
  const clientEntry = pathToFileURL(join(ROOT, 'node_modules/svelte/src/index-client.js')).href;
  const { mount } = (await import(clientEntry)) as {
    mount: (component: unknown, options: { target: unknown; props: Record<string, unknown> }) => unknown;
  };
  mount(clientModule.default, { target: window.document.body, props });
  return window as Window & typeof globalThis;
}

describe('remote profile SSR safety', () => {
  const loadPage = async () =>
    (
      await compileModule('src/lib/svelte/RemoteProfilePage.svelte', {
        '../../components/MediaCarousel.ts': pathToFileURL(join(ROOT, 'src/lib/media/attachments.ts')).href,
        '../navigation.ts': navigationStub,
      })
    ).default as Renderable;

  it('distinguishes a pending follow request from an accepted follow and a plain Follow', async () => {
    const component = await loadPage();
    const pending = renderHtml(
      component,
      profileProps({
        initialProfile: { ...profileProps().initialProfile, following: false, follow_state: 'pending' },
      }),
    );
    assert.match(pending, /Request sent/);
    assert.match(pending, /disabled=""/, 'a pending request must be disabled to prevent duplicates');
    assert.doesNotMatch(pending, />Follow</);

    const accepted = renderHtml(
      component,
      profileProps({
        initialProfile: { ...profileProps().initialProfile, following: true, follow_state: 'accepted' },
      }),
    );
    assert.match(accepted, /Unfollow/);
    assert.doesNotMatch(accepted, /Request sent/);

    const none = renderHtml(component, profileProps());
    assert.match(none, /Follow/);
    assert.doesNotMatch(none, /Request sent|Unfollow/);
  });

  it('rejects a non-http avatar URL but renders a safe http(s) avatar', async () => {
    const component = await loadPage();
    const unsafe = renderHtml(
      component,
      profileProps({
        initialProfile: {
          ...profileProps().initialProfile,
          actor: { ...profileProps().initialProfile.actor, icon_url: 'javascript:alert(1)' },
        },
      }),
    );
    assert.doesNotMatch(unsafe, /javascript:alert\(1\)/);
    assert.doesNotMatch(unsafe, /class="profile-avatar-image"/);

    const safe = renderHtml(
      component,
      profileProps({
        initialProfile: {
          ...profileProps().initialProfile,
          actor: { ...profileProps().initialProfile.actor, icon_url: 'https://remote.example/avatar.png' },
        },
      }),
    );
    assert.match(safe, /<img class="profile-avatar-image" src="https:\/\/remote\.example\/avatar\.png"/);
  });

  it('uses translated labels instead of hardcoded link/file filename fallbacks', async () => {
    const component = await loadPage();
    const attachment = (r2Key: string) => ({
      initialProfile: {
        ...profileProps().initialProfile,
        posts: [
          {
            id: 'p1',
            text: 'hello',
            created_at: '2026-01-01T00:00:00.000Z',
            attachments: [{ kind: 'other', r2_key: r2Key, position: 0 }],
          },
        ],
      },
    });
    const remote = renderHtml(component, profileProps(attachment('https://remote.example/')));
    assert.match(remote, new RegExp(en['composer.preview_open_document']));
    assert.doesNotMatch(remote, /↗ link/);

    const local = renderHtml(component, profileProps(attachment('')));
    assert.match(local, new RegExp(en['composer.download_file']));
    assert.doesNotMatch(local, /↗ file/);
  });
});

describe('composer accessibility', () => {
  it('gives the visibility select a single label and exposes both hints as descriptions', async () => {
    const component = await compileModule('src/lib/svelte/PostComposer.svelte', {
      '../../components/StampPicker.ts': stampPickerStub,
      '../file-preview.ts': filePreviewStub,
      '../composer/media-list.ts': mediaListStub,
      '../toast.ts': toastStub,
      '../vault/session.ts': vaultSessionStub,
      '../vault/items.ts': vaultItemsStub,
    });
    const html = renderHtml(component.default as Renderable, { currentUser: { username: 'alice' } });
    const window = new Window({ url: 'https://flaxia.app' });
    window.document.body.innerHTML = html;
    const select = window.document.querySelector('select.composer-visibility-select');
    assert.ok(select, 'the visibility select must render');
    let ancestor = select.parentElement;
    let depth = 0;
    while (ancestor && depth++ < 20) {
      assert.notEqual(ancestor.tagName, 'LABEL', 'the select must not be wrapped by a label with extra text');
      ancestor = ancestor.parentElement;
    }

    const labelledBy = select.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'the select needs aria-labelledby');
    const labels = labelledBy.split(/\s+/).map((id) => window.document.getElementById(id)?.textContent?.trim());
    assert.deepEqual(labels, [en['composer.visibility_label']], 'the accessible name must be just the label');

    const describedBy = select.getAttribute('aria-describedby');
    assert.ok(describedBy, 'the select needs aria-describedby');
    const descriptions = describedBy.split(/\s+/).map((id) => window.document.getElementById(id)?.textContent?.trim());
    assert.deepEqual(descriptions, [en['composer.visibility_hint'], en['composer.mention_remote_hint']]);
    window.happyDOM.cancelAsync();
  });

  it('keeps the federation hints visible when the composer is not focused', async () => {
    const css = await readFile(join(ROOT, 'src/styles/redesign/composer.css'), 'utf8');
    const window = new Window({ url: 'https://flaxia.app' });
    window.document.body.innerHTML =
      '<div class="post-composer"><span class="composer-visibility-hint">hint</span></div>';
    const style = window.document.createElement('style');
    style.textContent = css;
    window.document.head.appendChild(style);
    const hint = window.document.querySelector('.composer-visibility-hint');
    assert.ok(hint);
    assert.notEqual(window.getComputedStyle(hint).display, 'none', 'hints must be readable during normal browsing');
    window.happyDOM.cancelAsync();
  });
});
