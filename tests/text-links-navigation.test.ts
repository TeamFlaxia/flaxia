// Behavioural guards for SPA navigation in post text linkifiers.
//
// These click handlers run in the browser inside SvelteKit. The deleted
// `spaNavigate` bridge and raw `history.pushState` calls left them dead and
// corrupted SvelteKit's `history.state`, so navigation must go through the
// shared `navigate()` helper with the URL target intact. The source guard
// below keeps those forbidden APIs out; the DOM tests run the real linkifiers
// in happy-dom and click the spans they create instead of reading the handler
// text to guess what they do.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';

const source = await readFile(new URL('../src/lib/post/text-links.ts', import.meta.url), 'utf8');

// text-links.ts lazily imports navigation.ts, which imports SvelteKit's
// `$app/navigation` virtual module. Stub that module so the real navigate()
// helper runs under Node and records the target it passes to goto().
const loader = `
const STUB_APP = 'data:text/javascript,' + encodeURIComponent([
  "export const goto = async (url) => { globalThis.__GOTO__ ??= []; globalThis.__GOTO__.push(url); };",
  "export const preloadCode = async () => {};",
  "export const preloadData = async () => {};",
].join('\\n'));
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('$app/')) return { url: STUB_APP, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(loader));

const win = new Window({ url: 'https://flaxia.test/' });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.localStorage = win.localStorage;
for (const key of ['Node', 'Element', 'HTMLElement', 'Text', 'DocumentFragment', 'NodeFilter', 'Event', 'MouseEvent']) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}

const gotoTargets = (): string[] => (globals.__GOTO__ as string[] | undefined) ?? [];

/** Click a linked span and wait for the lazy navigation import to settle. */
async function clickAndNavigate(span: HTMLElement): Promise<string[]> {
  const before = gotoTargets().length;
  span.click();
  for (let attempt = 0; attempt < 50 && gotoTargets().length === before; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gotoTargets().length, before + 1, 'a text link click must navigate exactly once');
  return gotoTargets().slice(before);
}

afterEach(() => {
  globals.__GOTO__ = [];
});

test('text link clicks leave history to the SvelteKit router', () => {
  // (b) the bridge deleted in d10f70d4 must not be resurrected anywhere here.
  assert.doesNotMatch(source, /spaNavigate/);
  // (a) no module-level or handler-level history mutation.
  assert.doesNotMatch(source, /history\.(?:pushState|replaceState)/);

  // (c) navigation must come from the shared helper, either as a static import
  // at module scope or as a lazy import inside the handler.
  assert.match(
    source,
    /import\s*\{[^}]*\bnavigate\b[^}]*\}\s*from\s*['"]\.\.\/navigation(?:\.ts)?['"]|import\(['"]\.\.\/navigation\.ts['"]\)/,
    'expected navigate() to be imported from ../navigation.ts',
  );
});

test('hashtags and mentions navigate through the shared helper with the right targets', async () => {
  const { linkifyHashtags, linkifyMentions } = await import('../src/lib/post/text-links.ts');

  const hashtags = document.createElement('div');
  hashtags.textContent = 'topic #flaxia';
  linkifyHashtags(hashtags);
  const hashtag = hashtags.querySelector('.hashtag-link') as HTMLElement | null;
  assert.ok(hashtag, 'linkifyHashtags must create a clickable span');
  assert.equal(hashtag.textContent, '#flaxia');
  assert.deepEqual(await clickAndNavigate(hashtag), ['/explore?tag=flaxia']);

  const mentions = document.createElement('div');
  mentions.textContent = 'hi @bob@example.org and @known and @unknown';
  // The click must still bubble to PostCard's fallback handler.
  let bubbled = 0;
  mentions.addEventListener('click', () => {
    bubbled += 1;
  });
  linkifyMentions(
    mentions,
    JSON.stringify([
      { username: 'known', user_id: 'u2' },
      { username: 'bob', domain: 'example.org', url: 'https://example.org/users/bob' },
    ]),
  );

  const links = Array.from(mentions.querySelectorAll('.mention-link')) as HTMLElement[];
  assert.deepEqual(
    links.map((link) => link.textContent),
    ['@bob@example.org', '@known'],
    'a mention with no known local user must stay plain text',
  );
  assert.deepEqual(
    links.map((link) => link.getAttribute('data-mention-target')),
    ['/@example.org/bob', '/profile/known'],
    'the DOM must expose the internal profile targets',
  );

  assert.deepEqual(await clickAndNavigate(links[0]), ['/@example.org/bob'], 'remote mentions use the internal route');
  assert.deepEqual(await clickAndNavigate(links[1]), ['/profile/known'], 'local mentions use the profile route');
  assert.equal(bubbled, 2, 'mention clicks must bubble to the PostCard fallback handler');
  assert.ok(mentions.textContent?.includes('@unknown'), 'an unrecognised mention is not a link');
});
