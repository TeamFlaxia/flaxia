// Source-level regression guards for SPA navigation in post text linkifiers.
//
// These click handlers run in the browser inside SvelteKit. The deleted
// `spaNavigate` bridge and raw `history.pushState` calls left them dead and
// corrupted SvelteKit's `history.state`, so the contract checked here is:
// route through the shared `navigate()` helper, keep the URL targets intact,
// and let the event bubble to the PostCard fallback handler.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/lib/post/text-links.ts', import.meta.url), 'utf8');

/** Extract the body of the click listener created for a given span class. */
function clickHandlerFor(className: string): string {
  const classMarker = `span.className = '${className}';`;
  const classAt = source.indexOf(classMarker);
  assert.notEqual(classAt, -1, `${className} span was not found`);

  const listenerAt = source.indexOf("addEventListener('click'", classAt);
  assert.notEqual(listenerAt, -1, `${className} click handler was not found`);

  const open = source.indexOf('{', listenerAt);
  const close = source.indexOf('});', open);
  assert.notEqual(close, -1, `${className} click handler end was not found`);

  return source.slice(open, close);
}

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

  for (const { className, path, value } of [
    { className: 'hashtag-link', path: '/explore?tag=', value: 'hashtag' },
    { className: 'mention-link', path: '/profile/', value: 'username' },
  ]) {
    const handler = clickHandlerFor(className);

    assert.match(handler, /\bnavigate\(/, `${className} handler must call navigate()`);
    assert.match(handler, new RegExp(path.replace(/[?/]/g, '\\$&')), `${className} handler lost its URL target`);
    assert.match(handler, new RegExp(`encodeURIComponent\\(${value}\\)`), `${className} value must stay encoded`);
    // (d) the click must reach PostCard's fallback handler.
    assert.doesNotMatch(handler, /stopPropagation/, `${className} handler must not stop propagation`);
  }
});
