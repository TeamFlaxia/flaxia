// Behavioural tests for the remote-post text fold. The Svelte component is
// compiled to the client runtime on the fly and mounted in happy-dom so the
// toggle, the accessible state and the visible text are exercised for real.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { foldRemoteText, isRemotePost, REMOTE_TEXT_PREVIEW_LENGTH } from '../shared/post-text.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const loader = `
import { readFileSync } from 'node:fs';
import { compile } from 'file://${ROOT}/node_modules/svelte/src/compiler/index.js';
const CLIENT_SVELTE = 'file://${ROOT}/node_modules/svelte/src/index-client.js';
const STUB_APP = 'data:text/javascript,' + encodeURIComponent([
  "export const goto = async () => {};",
  "export const preloadCode = async () => {};",
  "export const preloadData = async () => {};",
  "export const invalidateAll = async () => {};",
  "export const page = {};",
  "export const browser = false;",
  "export const dev = false;",
  "export const env = {};",
].join('\\n'));
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('$app/')) return { url: STUB_APP, shortCircuit: true };
  if (specifier === 'svelte') return { url: CLIENT_SVELTE, shortCircuit: true };
  if (specifier === 'svelte/legacy') return { url: 'file://${ROOT}/node_modules/svelte/src/legacy/legacy-client.js', shortCircuit: true };
  if (specifier === 'svelte/store') return { url: 'file://${ROOT}/node_modules/svelte/src/store/index-client.js', shortCircuit: true };
  if (specifier === 'svelte/reactivity') return { url: 'file://${ROOT}/node_modules/svelte/src/reactivity/index-client.js', shortCircuit: true };
  return nextResolve(specifier, context);
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

// The i18n module reads the SSR-inlined locale at import time. Provide the real
// Japanese strings so the assertions cover the translations, not a fallback key.
const ja = JSON.parse(await read('public/locales/ja.json')) as Record<string, string>;
const en = JSON.parse(await read('public/locales/en.json')) as Record<string, string>;
(win as unknown as { __FLAXIA_LOCALE__: unknown }).__FLAXIA_LOCALE__ = {
  locale: 'ja',
  strings: ja,
  fallback: en,
};

const client = (await import(pathToFileURL(join(ROOT, 'node_modules/svelte/src/index-client.js')).href)) as {
  mount: (component: unknown, options: { target: Element; props: Record<string, unknown> }) => unknown;
  unmount: (instance: unknown) => void;
};
const { default: PostText } = (await import(pathToFileURL(join(ROOT, 'src/lib/svelte/PostText.svelte')).href)) as {
  default: unknown;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// The rich-text pipeline wraps the body in a paragraph, which adds a trailing
// newline to textContent; compare the visible characters, not that wrapper.
const renderedText = (root: Element): string =>
  (root.querySelector('.post-text')?.textContent ?? '').replace(/\n+$/, '');

async function mountText(text: string, foldRemote: boolean): Promise<{ root: Element; done: () => void }> {
  const root = win.document.createElement('div');
  win.document.body.append(root);
  const instance = client.mount(PostText, { target: root, props: { text, foldRemote } });
  return {
    root,
    done: () => {
      client.unmount(instance);
      root.remove();
    },
  };
}

describe('remote post text fold', () => {
  it('shows only the first 200 characters until the reader expands a remote post', async () => {
    const body = `${'あ'.repeat(200)}${'い'.repeat(120)}`;
    const page = await mountText(body, true);
    try {
      const button = page.root.querySelector('button.post-text-fold-toggle');
      assert.ok(button, 'a long remote post must have a toggle');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.getAttribute('aria-expanded'), 'false');
      assert.equal(button.textContent?.trim(), ja.post_text_continue);
      assert.equal(renderedText(page.root), 'あ'.repeat(200));

      button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.equal(renderedText(page.root), body);
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      assert.equal(button.textContent?.trim(), ja.post_text_show_less);

      button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.equal(renderedText(page.root), 'あ'.repeat(200));
      assert.equal(button.getAttribute('aria-expanded'), 'false');
    } finally {
      page.done();
    }
  });

  it('leaves short remote posts and all local posts on the existing path', async () => {
    for (const [text, foldRemote] of [
      ['short remote note', true],
      [`${'x'.repeat(250)}`, false],
    ] as const) {
      const page = await mountText(text, foldRemote);
      try {
        assert.equal(page.root.querySelector('button.post-text-fold-toggle'), null);
        assert.equal(renderedText(page.root), text);
      } finally {
        page.done();
      }
    }
  });

  it('never renders remote markup as HTML in the folded text', async () => {
    const body = `${'a'.repeat(200)}<script>alert(1)</script>`;
    const page = await mountText(body, true);
    try {
      assert.equal(renderedText(page.root), 'a'.repeat(200));
      assert.equal(page.root.querySelector('script'), null);
      page.root.querySelector('button')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await tick();
      assert.equal(page.root.querySelector('script'), null);
      assert.match(renderedText(page.root), /alert\(1\)/);
    } finally {
      page.done();
    }
  });
});

describe('fold helpers and translations', () => {
  it('folds by character count without splitting surrogate pairs', () => {
    assert.equal(foldRemoteText('a'.repeat(REMOTE_TEXT_PREVIEW_LENGTH)), null);
    const plain = foldRemoteText(`${'a'.repeat(200)}rest`);
    assert.equal(plain?.preview, 'a'.repeat(200));
    assert.equal(plain?.rest, 'rest');
    const emoji = foldRemoteText(`${'a'.repeat(199)}😀rest`);
    assert.equal(emoji?.preview, `${'a'.repeat(199)}😀`);
    assert.equal(emoji?.rest, 'rest');
  });

  it('detects remote posts from either the federation flag or actor id', () => {
    assert.equal(isRemotePost({ is_remote: true }), true);
    assert.equal(isRemotePost({ is_remote: 1 }), true);
    assert.equal(isRemotePost({ actor_id: 'https://remote.example/users/alice' }), true);
    assert.equal(isRemotePost({ is_remote: false, actor_id: null }), false);
  });

  it('defines both toggle labels in Japanese and English', async () => {
    for (const [locale, data] of [
      ['ja', ja],
      ['en', en],
    ] as const) {
      assert.ok(data.post_text_continue, `${locale} must translate post_text_continue`);
      assert.ok(data.post_text_show_less, `${locale} must translate post_text_show_less`);
    }
    assert.equal(ja.post_text_continue, '続き');
    assert.equal(en.post_text_continue, 'Continue reading');
    const source = await read('src/lib/svelte/PostText.svelte');
    assert.match(source, /t\('post_text_continue'\)/);
    assert.match(source, /t\('post_text_show_less'\)/);
    assert.doesNotMatch(source, /innerHTML/, 'the fold must not introduce innerHTML for dynamic text');
  });
});
