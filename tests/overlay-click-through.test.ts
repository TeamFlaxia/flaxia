// Full-screen loaders and tutorial overlays must not swallow clicks once they
// are inert. An element with opacity: 0 still receives pointer events, and a
// document-level capture blocker kills every click on the page.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ArcadeTutorial does not install a document-level click/touch blocker', async () => {
  const source = await read('src/lib/svelte/arcade/ArcadeTutorial.svelte');
  assert.doesNotMatch(
    source,
    /document\.addEventListener\(\s*['"](?:click|touchstart)['"]/,
    'tutorial must not swallow outside clicks/touches via a document capture listener',
  );
  assert.doesNotMatch(source, /\bblockOutside\b/, 'the outside-event blocker must be removed');
  // Dismissal must still work through the tutorial's own controls.
  assert.match(source, /onclick=\{onClose\}/, 'tutorial must remain dismissible');
});

test('zip-ui-utils loader is click-through and the timeout path removes it', async () => {
  const source = await read('src/lib/zip-ui-utils.ts');
  assert.match(
    source,
    /pointer-events\s*:\s*none|pointerEvents\s*[:=]\s*['"]none['"]/,
    'full-screen loader must be pointer-events: none',
  );
  const timeoutBody = source.slice(source.indexOf('export function showLoadingTimeoutMessage'));
  assert.match(
    timeoutBody,
    /fadeOutLoading\(\s*loadingEl\s*\)/,
    'timeout branch must fade out/remove the loader instead of only rewriting innerHTML',
  );
});

test('FlashPlayer loader stops receiving pointer events when the iframe is visible', async () => {
  const source = await read('src/lib/svelte/media/FlashPlayer.svelte');
  const loadingTag = source.match(/<div\s[^>]*class="flash-loading"[^>]*>/)?.[0];
  assert.ok(loadingTag, 'flash-loading element must exist');
  assert.match(
    loadingTag,
    /pointer-events:\s*(?:none|\{iframeVisible \? 'none')/,
    'flash-loading must be pointer-events: none once iframeVisible',
  );
});

test('zip-executor removes the loader on iframe load timeout', async () => {
  const source = await read('src/lib/zip-executor.ts');
  const timeoutBranch = source.match(/\n {4}\} else \{\n([\s\S]*?)\n {4}\}\n\n {4}const handle/);
  assert.ok(timeoutBranch, 'expected executeZip timeout else branch');
  assert.match(timeoutBranch[1], /loadingEl\.remove\(\)/, 'timeout branch must remove the retained loader');
  assert.match(source, /pointer-events:\s*none/, 'legacy full-screen loader must be pointer-events: none');
});
