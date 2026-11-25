// SSR-only CSS must not redefine the global legacy classes: main.css already
// owns post colours and the dinnerborn glyph, and two copies drift apart.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ssr.css does not duplicate legacy global selectors', async () => {
  const [ssr, main] = await Promise.all([read('src/styles/ssr.css'), read('src/styles/main.css')]);
  assert.match(main, /\.post-color--red\s*\{/);
  assert.match(main, /\.post-dinnerborn\s*\{/);

  for (const selector of ['.post-color--red', '.post-color--rainbow', '.post-dinnerborn']) {
    assert.doesNotMatch(ssr, new RegExp(`\\${selector}\\s*\\{`), `${selector} is already global in main.css`);
  }
  assert.doesNotMatch(ssr, /forced-colors: active/, 'the forced-colors override is global in main.css');
});

test('ssr.css still styles the SSR-only markup', async () => {
  const ssr = await read('src/styles/ssr.css');
  for (const selector of ['.ssr-post', '.ssr-feed', '.ssr-profile']) {
    assert.match(ssr, new RegExp(`\\${selector}\\s*\\{`), `${selector} must keep its no-JS styling`);
  }
});
