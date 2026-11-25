// The root layout resolves the session in the browser BEFORE hydration, so a
// page that calls getSessionUser() while rendering produces different markup
// on the client than the server sent. Pages must start from null and hydrate
// the session in onMount (as home/thread/users already do).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const FILES = [
  'src/routes/explore/+page.svelte',
  'src/routes/search/+page.svelte',
  'src/routes/profile/[username]/+page.svelte',
  'src/routes/@[domain]/[username]/+page.svelte',
];

test('SSR pages do not read the client-only session during render', async () => {
  for (const file of FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /import \{ onMount \} from 'svelte'/, `${file} must hydrate the session in onMount`);
    assert.match(source, /let currentUser = \$state[^\n]*null/, `${file} must start with a null session`);
    assert.match(
      source,
      /onMount\(\(\)\s*=>\s*\{[\s\S]*?currentUser = getSessionUser\(\)/,
      `${file} must set the session in onMount`,
    );
    const markup = source.slice(source.indexOf('</script>'));
    assert.doesNotMatch(markup, /getSessionUser\(\)/, `${file} must not call getSessionUser() in markup`);
  }
});
