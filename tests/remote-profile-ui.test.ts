// Behavioural guards for internal remote-profile navigation and bio rendering.
//
// Remote authors must open their local `/@domain/user` page instead of the
// original instance, and their untrusted `summary` must be rendered as escaped
// text rather than injected HTML. These tests mount the real components in a
// happy-dom document and click the real handlers instead of reading source.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const ROOT = new URL('..', import.meta.url).pathname;

// Node cannot import .svelte files and Svelte resolves to its server entry
// under Node conditions. This resolver compiles components for the client
// runtime on demand; app-only imports are stubbed because they need SvelteKit.
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
// Node's own Event/CustomEvent are not happy-dom Event instances, and
// happy-dom's dispatchEvent rejects them. Svelte components construct these
// globals directly (e.g. signalSsrHandover), so the DOM classes must win here.
globals.Event = win.Event;
globals.CustomEvent = win.CustomEvent;
globals.MouseEvent = win.MouseEvent;
globals.KeyboardEvent = win.KeyboardEvent;

const opened: unknown[][] = [];
Object.defineProperty(win, 'open', {
  configurable: true,
  value: (...args: unknown[]) => {
    opened.push(args);
    return null;
  },
});

const originalFetch = globalThis.fetch;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  globals.__GOTO__ = [];
  opened.length = 0;
  globalThis.fetch = originalFetch;
  globals.__PAGE__ = undefined;
});

async function mount(path: string, props: Record<string, unknown>): Promise<{ root: Element; done: () => void }> {
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

const headerProps = {
  username: 'bob',
  display_name: 'Bob',
  createdAt: '2026-01-01T00:00:00.000Z',
  badge_type: null,
  name_color: null,
};

describe('remote profile navigation', () => {
  it('prefers the internal profile path over the external actor URL', async () => {
    const page = await mount('src/lib/svelte/PostHeader.svelte', {
      ...headerProps,
      profile_path: '/@remote.example/bob',
      profile_url: 'https://remote.example/users/bob',
    });
    try {
      page.root.querySelector('.post-display-name')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.deepEqual(globals.__GOTO__, ['/@remote.example/bob']);
      assert.deepEqual(opened, [], 'the external instance must not be opened when a local path exists');
    } finally {
      page.done();
    }
  });

  it('opens the external actor URL only as a fallback', async () => {
    const page = await mount('src/lib/svelte/PostHeader.svelte', {
      ...headerProps,
      profile_url: 'https://remote.example/users/bob',
    });
    try {
      page.root.querySelector('.post-display-name')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.deepEqual(globals.__GOTO__, []);
      assert.deepEqual(opened, [['https://remote.example/users/bob', '_blank', 'noopener,noreferrer']]);
    } finally {
      page.done();
    }
  });

  it('falls back to the local profile when neither field is present', async () => {
    const page = await mount('src/lib/svelte/PostHeader.svelte', { ...headerProps });
    try {
      page.root.querySelector('.post-username')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.deepEqual(globals.__GOTO__, ['/profile/bob']);
    } finally {
      page.done();
    }
  });

  it('stops the profile click from reaching the card', async () => {
    const card = win.document.createElement('div');
    win.document.body.append(card);
    const bubbled: string[] = [];
    card.addEventListener('click', () => bubbled.push('card'));
    const target = win.document.createElement('div');
    card.append(target);
    const module = (await import(pathToFileURL(join(ROOT, 'src/lib/svelte/PostHeader.svelte')).href)) as {
      default: unknown;
    };
    const instance = client.mount(module.default, {
      target,
      props: { ...headerProps, profile_path: '/@remote.example/bob' },
    });
    try {
      target.querySelector('.post-display-name')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.deepEqual(bubbled, [], 'the card handler must not see the profile click');
      assert.deepEqual(globals.__GOTO__, ['/@remote.example/bob']);
    } finally {
      client.unmount(instance);
      card.remove();
    }
  });

  it('forwards profile_path from the post into the header', async () => {
    const post = {
      id: 'p1',
      user_id: '',
      username: 'bob',
      display_name: 'Bob',
      text: 'remote note',
      created_at: headerProps.createdAt,
      profile_path: '/@remote.example/bob',
      actor_id: 'https://remote.example/users/bob',
      hashtags: '[]',
      mentions: '[]',
      attachments: [],
      fresh_count: 0,
      reply_count: 0,
      badge_type: null,
      name_color: null,
    };
    const page = await mount('src/lib/svelte/PostCard.svelte', {
      post,
      sandboxOrigin: 'https://sandbox.flaxia.app',
      currentUser: null,
    });
    try {
      page.root.querySelector('.post-display-name')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.deepEqual(
        globals.__GOTO__,
        ['/@remote.example/bob'],
        'the header must navigate using the post’s local path',
      );
    } finally {
      page.done();
    }
  });
});

describe('remote profile bio rendering', () => {
  const initialProfile = {
    actor: {
      actor_url: 'https://remote.example/users/bob',
      display_name: '<b>Bob</b>',
      icon_url: null,
      bio: '<script>alert(1)</script> hello & goodbye',
    },
    following: false,
    posts: [{ id: 'p1', text: 'a <img src=x> post', created_at: '2026-01-01T00:00:00.000Z' }],
  };

  it('renders the untrusted bio as escaped text inside profile-bio', async () => {
    const page = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'bob',
      currentUser: null,
      initialProfile,
    });
    try {
      const bio = page.root.querySelector('.profile-bio');
      assert.ok(bio, 'the bio must be rendered');
      assert.equal(bio.textContent, '<script>alert(1)</script> hello & goodbye');
      assert.equal(bio.querySelector('script, img, b'), null, 'markup in the summary must never become an element');
      assert.equal(page.root.querySelector('.profile-bio-label')?.textContent?.trim(), 'remote_profile.bio_label');
      const postText = page.root.querySelector('.post-text');
      assert.equal(postText?.textContent, 'a <img src=x> post');
      assert.equal(postText?.querySelector('img'), null);
    } finally {
      page.done();
    }
  });

  it('links to the original actor only for safe http(s) URLs', async () => {
    const safe = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'bob',
      currentUser: null,
      initialProfile,
    });
    try {
      const link = safe.root.querySelector('a.profile-instance-link');
      assert.equal(link?.getAttribute('href'), 'https://remote.example/users/bob');
      assert.equal(link?.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(link?.textContent?.trim(), 'remote_profile.view_on_instance');
    } finally {
      safe.done();
    }

    const unsafe = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'bob',
      currentUser: null,
      initialProfile: { ...initialProfile, actor: { ...initialProfile.actor, actor_url: 'javascript:alert(1)' } },
    });
    try {
      assert.equal(
        unsafe.root.querySelector('a.profile-instance-link'),
        null,
        'a javascript: actor URL must not become a link',
      );
    } finally {
      unsafe.done();
    }
  });

  it('reuses SSR data without a duplicate fetch and signals handover', async () => {
    const fetched: string[] = [];
    const handovers: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify(initialProfile), { status: 200 });
    }) as typeof fetch;
    win.addEventListener('flaxia:ssr-handover', () => handovers.push('handover'));

    const ssr = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'bob',
      currentUser: null,
      initialProfile,
    });
    try {
      await tick();
      assert.deepEqual(fetched, [], 'the SSR payload must not be fetched again');
      assert.deepEqual(handovers, ['handover']);
    } finally {
      ssr.done();
    }

    const clientOnly = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'carol',
      currentUser: null,
    });
    try {
      await tick();
      assert.deepEqual(fetched, ['/api/remote/actors/remote.example/carol']);
      assert.equal(handovers.length, 2, 'the fetched profile must take over from the SSR fallback');
    } finally {
      clientOnly.done();
    }
  });
});

describe('remote follow state', () => {
  const actor = {
    actor_url: 'https://remote.example/users/bob',
    display_name: 'Bob',
    icon_url: null,
    bio: null,
  };
  const button = (root: Element): HTMLButtonElement => {
    const found = root.querySelector('.profile-follow-button');
    assert.ok(found, 'the follow button must be rendered');
    return found as HTMLButtonElement;
  };

  it('shows a sent follow request as pending and disables the button on SSR data', async () => {
    const page = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'bob',
      currentUser: { username: 'alice' },
      initialProfile: { actor, following: false, follow_state: 'sent', posts: [] },
    });
    try {
      assert.equal(button(page.root).textContent?.trim(), 'search.remote_follow_pending');
      assert.equal(button(page.root).disabled, true, 'a delivered request must not be sent twice');
    } finally {
      page.done();
    }
  });

  it('shows a sent follow request as pending after a client fetch', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ actor, following: false, follow_state: 'sent', posts: [] }), {
        status: 200,
      })) as typeof fetch;
    const page = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
      domain: 'remote.example',
      username: 'bob',
      currentUser: { username: 'alice' },
    });
    try {
      await tick();
      await tick();
      assert.equal(button(page.root).textContent?.trim(), 'search.remote_follow_pending');
      assert.equal(button(page.root).disabled, true);
    } finally {
      page.done();
    }
  });

  it('keeps rejected and absent states actionable', async () => {
    for (const followState of ['rejected', null]) {
      const page = await mount('src/lib/svelte/RemoteProfilePage.svelte', {
        domain: 'remote.example',
        username: 'bob',
        currentUser: { username: 'alice' },
        initialProfile: { actor, following: false, follow_state: followState, posts: [] },
      });
      try {
        assert.equal(button(page.root).textContent?.trim(), 'profile.follow');
        assert.equal(button(page.root).disabled, false);
      } finally {
        page.done();
      }
    }
  });
});
