// Unit coverage for the pure post-text helpers extracted out of the legacy
// PostText factory. The DOM is installed before importing the module because
// DOMPurify and the linkifiers read globals at call time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://flaxia.test/' });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.Node = window.Node;
globals.Element = window.Element;
globals.HTMLElement = window.HTMLElement;
globals.Text = window.Text;
globals.DocumentFragment = window.DocumentFragment;
globals.NodeFilter = window.NodeFilter;
globals.Range = window.Range;
globals.Event = window.Event;
globals.CustomEvent = window.CustomEvent;
globals.KeyboardEvent = window.KeyboardEvent;

const {
  applyPostText,
  linkifyHashtags,
  linkifyMentions,
  linkifyPostRefs,
  linkifyUrls,
  processText,
  renderCueInlineHtml,
} = await import('../src/components/PostText.ts');

test('processText renders Markdown and neutralizes raw HTML', async () => {
  const html = await processText('Hello **bold** <script>alert(1)</script>');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('processText keeps cue lines and headings out of the body', async () => {
  const html = await processText('# Not a heading\nBody line\n01:36.12 timed comment');
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /Body line/);
  assert.doesNotMatch(html, /timed comment/);
});

test('processText leaves color markers literal when colors are disabled', async () => {
  const html = await processText('{red}hot{/red} plain');
  assert.match(html, /\{red\}hot\{\/red\}/);
});

test('linkifiers decorate text nodes and skip links and code', () => {
  const container = document.createElement('div');
  container.appendChild(
    document.createTextNode('Hi @known and @ghost #flaxia https://example.com www.example.org >>3'),
  );
  const anchor = document.createElement('a');
  anchor.href = 'https://already.test';
  anchor.textContent = '@known #inside https://already.test';
  const code = document.createElement('code');
  code.textContent = '@known #code https://code.test';
  container.append(anchor, code);

  linkifyUrls(container);
  linkifyHashtags(container);
  linkifyMentions(container, JSON.stringify([{ username: 'known', user_id: 'u2' }]));
  linkifyPostRefs(container);

  assert.equal(container.querySelectorAll('.mention-link').length, 1);
  assert.equal(container.querySelector('.mention-link')?.textContent, '@known');
  assert.equal(container.querySelectorAll('.hashtag-link').length, 1);
  assert.equal(container.querySelector('.hashtag-link')?.textContent, '#flaxia');
  assert.equal(container.querySelectorAll('a.url-link').length, 2);
  assert.equal(container.querySelector('a.url-link')?.getAttribute('href'), 'https://example.com');
  assert.equal(container.querySelectorAll('.post-ref-link').length, 1);
  assert.equal(container.querySelector('.post-ref-link')?.getAttribute('data-post-index'), '3');

  const existingAnchor = container.querySelector('a[href="https://already.test"]');
  assert.equal(existingAnchor?.querySelector('.mention-link'), null, 'mentions inside anchors stay literal');
  assert.equal(existingAnchor?.querySelector('.hashtag-link'), null, 'hashtags inside anchors stay literal');
  const codeBlock = container.querySelector('code');
  assert.equal(codeBlock?.querySelector('.mention-link'), null, 'mentions inside code stay literal');
  assert.equal(codeBlock?.querySelector('.hashtag-link'), null, 'hashtags inside code stay literal');
});

test('applyPostText renders colors, mentions, hashtags, URLs and post refs', async () => {
  const container = document.createElement('div');
  await applyPostText(container, {
    text: '{red}hot{/red} @known #flaxia https://example.com >>2',
    mentions: JSON.stringify([{ username: 'known', user_id: 'u2' }]),
    enableColors: true,
    enablePostRefs: true,
  });

  assert.ok(container.querySelector('.post-color--red'), 'color span missing');
  assert.equal(container.querySelector('.mention-link')?.textContent, '@known');
  assert.equal(container.querySelector('.hashtag-link')?.textContent, '#flaxia');
  assert.equal(container.querySelector('a.url-link')?.getAttribute('href'), 'https://example.com');
  assert.equal(container.querySelector('.post-ref-link')?.getAttribute('href'), '#post-2');
});

test('applyPostText aborts a stale render through shouldApply', async () => {
  const container = document.createElement('div');
  await applyPostText(container, { text: '**stale**' }, () => false);
  assert.equal(container.innerHTML, '');
});

test('renderCueInlineHtml keeps inline Markdown and strips blocks', async () => {
  const html = await renderCueInlineHtml('**bold** <b>raw</b>\n- list');
  // happy-dom unwraps top-level inline markup inside DOMPurify, so this checks
  // the source was parsed/escaped rather than asserting the <strong> wrapper.
  assert.match(html, /bold/);
  assert.doesNotMatch(html, /\*\*bold\*\*/);
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /<li>/);
});
