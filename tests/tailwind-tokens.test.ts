// F3 guard: the Tailwind token layer must mirror the legacy theme values until
// F5-F8 moves surfaces over to it. A drift here would change the look silently.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const legacy = await readFile(new URL('../src/styles/legacy/theme.css', import.meta.url), 'utf8');
const tokens = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');

const readToken = (source, name) =>
  new RegExp(`${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}:\\s*([^;]+);`).exec(source)?.[1]?.trim();

test('Tailwind theme tokens mirror the legacy palette', () => {
  assert.match(tokens, /@theme\s*\{/, 'src/app.css must define an @theme block');
  const pairs = [
    ['--font-sans', '--font-sans'],
    ['--bg-primary', '--color-bg-primary'],
    ['--border', '--color-border'],
    ['--text-primary', '--color-text-primary'],
    ['--primary', '--color-primary'],
    ['--accent', '--color-accent'],
    ['--danger', '--color-danger'],
    ['--warning', '--color-warning'],
    ['--link', '--color-link'],
    ['--ring', '--color-ring'],
  ];
  for (const [legacyName, tailwindName] of pairs) {
    const expected = readToken(legacy, legacyName);
    assert.ok(expected, `legacy token ${legacyName} missing`);
    assert.equal(readToken(tokens, tailwindName), expected, `${tailwindName} must match ${legacyName}`);
  }
});
