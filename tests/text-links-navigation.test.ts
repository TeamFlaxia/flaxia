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

/** Extract the body of the Nth click listener created for a given span class. */
function clickHandlerFor(className: string, occurrence = 0): string | null {
  const classMarker = `span.className = '${className}';`;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    const classAt = source.indexOf(classMarker, from);
    if (classAt === -1) return null;
    from = classAt + classMarker.length;
  }

  const listenerAt = source.indexOf("addEventListener('click'", from);
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

  for (const { className, path, value } of [{ className: 'hashtag-link', path: '/explore?tag=', value: 'hashtag' }]) {
    const handler = clickHandlerFor(className);
    assert.ok(handler, `${className} handler was not found`);

    assert.match(handler, /\bnavigate\(/, `${className} handler must call navigate()`);
    assert.match(handler, new RegExp(path.replace(/[?/]/g, '\\$&')), `${className} handler lost its URL target`);
    assert.match(handler, new RegExp(`encodeURIComponent\\(${value}\\)`), `${className} value must stay encoded`);
    // (d) the click must reach PostCard's fallback handler.
    assert.doesNotMatch(handler, /stopPropagation/, `${className} handler must not stop propagation`);
  }

  // Mentions have two branches: local @user and remote @user@domain.
  const mentionHandlers = [clickHandlerFor('mention-link', 0), clickHandlerFor('mention-link', 1)].filter(
    (handler): handler is string => handler !== null,
  );
  assert.equal(mentionHandlers.length, 2, 'both local and remote mention handlers must exist');
  assert.ok(
    mentionHandlers.some(
      (handler) => handler.includes('/profile/') && handler.includes('encodeURIComponent(username)'),
    ),
    'local mentions must keep the encoded /profile/ target',
  );
  assert.ok(
    mentionHandlers.some((handler) => handler.includes('remoteMentionPath(')),
    'remote mentions must use the internal /@domain/user path',
  );
  for (const handler of mentionHandlers) {
    assert.match(handler, /\bnavigate\(/, 'mention handler must call navigate()');
    assert.doesNotMatch(handler, /stopPropagation/, 'mention click must bubble to PostCard');
  }
});
