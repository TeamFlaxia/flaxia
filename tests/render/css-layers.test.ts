import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('styles/css-entry', () => {
  it('loads the app through one stylesheet entry', () => {
    const main = read('src/main.ts');
    assert.match(main, /import '\.\/styles\/index\.css';/);
    assert.doesNotMatch(main, /styles\/redesign\//);
    assert.doesNotMatch(main, /styles\/render\/primitives\.css/);
  });

  it('imports the app CSS in cascade order and never in @layer', () => {
    const entry = read('src/styles/index.css');
    // Regression guard: `index.html` inlines unlayered critical CSS, and
    // unlayered declarations always beat layered ones. Wrapping the app CSS in
    // `@layer` silently reverted the redesign (240px nav, 1200px container,
    // unpadded post cards), so the entry must stay unlayered.
    assert.doesNotMatch(entry, /@layer\s+legacy/);
    assert.doesNotMatch(entry, /layer\(legacy\)|layer\(primitives\)/);
    assert.match(entry, /@import ['"]\.\/main\.css['"];/);
    assert.match(entry, /@import ['"]\.\/redesign\/foundation\.css['"];/);
    assert.match(entry, /@import ['"]\.\/render\/primitives\.css['"];/);
    assert.ok(
      entry.indexOf('./main.css') < entry.indexOf('./redesign/foundation.css'),
      'main.css must load before the redesign overrides',
    );
    assert.ok(
      entry.indexOf('./redesign/motion.css') < entry.indexOf('./render/primitives.css'),
      'primitives must load last so they can override legacy rules in source order',
    );
  });
});
