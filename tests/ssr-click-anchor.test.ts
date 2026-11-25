// Server-rendered cards must be clickable before Svelte hydrates. The only
// interactive element shipped with the static markup is the "View post"
// anchor; CSS stretches its hit area over the card without adding JS, inline
// handlers, or nested anchors (CSP script-src-attr: none).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type PostRow, renderPostArticle } from '../functions/lib/render-html.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function post(): PostRow {
  return {
    id: 'click-anchor-post',
    user_id: 'user-1',
    username: 'alice',
    display_name: 'Alice',
    avatar_key: null,
    text: 'clickable card #flax',
    hashtags: '[]',
    gif_key: null,
    payload_key: null,
    swf_key: null,
    thumbnail_key: null,
    fresh_count: 0,
    bookmark_count: 0,
    reply_count: 0,
    impressions: 0,
    parent_id: null,
    root_id: null,
    depth: 0,
    status: 'published',
    hidden: 0,
    created_at: '2026-01-02T12:00:00.000Z',
  };
}

test('SSR card has exactly one /thread/ anchor and it carries the stable class', () => {
  const html = renderPostArticle(post(), 'https://flaxia.app');
  const threadAnchors = html.match(/<a\b[^>]*href="[^"]*\/thread\/[^"]*"[^>]*>/g) ?? [];
  assert.equal(threadAnchors.length, 1, 'there must be exactly one thread link per card');
  assert.match(
    threadAnchors[0],
    /class="[^"]*\bssr-view-post\b[^"]*"/,
    'the thread link needs the ssr-view-post class',
  );
  // The overlay anchor must be a leaf: no nested markup inside it.
  assert.match(html, /<a[^>]*\bssr-view-post\b[^>]*>[^<]*<\/a>/, 'the overlay anchor must not wrap other elements');
});

test('SSR card introduces no nested anchors, scripts, or inline handlers', () => {
  const html = renderPostArticle(post(), 'https://flaxia.app');
  assert.doesNotMatch(html, /<a\b[^>]*>\s*<a\b/, 'nested anchors are invalid HTML');
  assert.doesNotMatch(html, /<script\b/i, 'no inline scripts (CSP script-src)');
  assert.doesNotMatch(html, /\bon[a-z]+\s*=/i, 'no inline event handler attributes (script-src-attr: none)');
});

test('ssr.css stretches the view-post anchor over the whole card', async () => {
  const css = await read('src/styles/ssr.css');
  assert.match(css, /\.ssr-post\s*\{[^}]*position:\s*relative/s, 'the card must be the containing block');

  const overlay = css.match(/\.ssr-view-post::after\s*\{([^}]*)\}/);
  assert.ok(overlay, '.ssr-view-post::after must be defined');
  assert.match(overlay[1], /content:\s*['"]{2}/, 'a pseudo-element needs content');
  assert.match(overlay[1], /position:\s*absolute/);
  assert.match(overlay[1], /inset:\s*0/);
  assert.match(overlay[1], /z-index:\s*1/);
});

test('ssr.css keeps the real inner links above the overlay', async () => {
  const css = (await read('src/styles/ssr.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];

  for (const selector of ['.ssr-post-header a', '.ssr-hashtag']) {
    const declarations = blocks
      .map((block) => {
        const brace = block.indexOf('{');
        return {
          selectors: block
            .slice(0, brace)
            .split(',')
            .map((part) => part.trim()),
          body: block.slice(brace + 1, -1),
        };
      })
      .find((rule) => rule.selectors.includes(selector))?.body;
    assert.ok(declarations, `${selector} must have a rule`);
    assert.match(declarations, /position:\s*relative/, `${selector} must be positioned to take part in stacking`);
    const zIndex = declarations.match(/z-index:\s*(\d+)/);
    assert.ok(zIndex, `${selector} must have a z-index above the overlay`);
    assert.ok(Number(zIndex[1]) > 1, `${selector} must sit above the z-index:1 overlay`);
  }
});
