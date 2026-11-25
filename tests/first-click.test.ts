// Small but real click-loss bugs: a delayed audio src swallowed an early play
// click, and a blur timer removed suggestion rows before the click completed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('audio play attaches src synchronously when clicked before init timer', async () => {
  const source = await read('src/lib/svelte/AudioPlayer.svelte');
  const start = source.indexOf('function togglePlay');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.match(body, /audioEl\.src\s*=\s*audioUrl/, 'togglePlay must attach src before playing');
});

test('search suggestions survive the input blur long enough to be clicked', async () => {
  for (const file of ['src/lib/svelte/SearchPage.svelte', 'src/lib/svelte/ExplorePage.svelte']) {
    const source = await read(file);
    assert.match(source, /onmousedown=\{/, `${file} must guard suggestion mousedown`);
    assert.match(source, /preventDefault\(\)/, `${file} must prevent blur on suggestion mousedown`);
  }
});
