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
    // The single stylesheet entry moved from legacy main.ts into the Svelte
    // root layout when main.ts was removed (#420).
    const layout = read('src/routes/+layout.svelte');
    assert.match(layout, /import '\.\.\/styles\/index\.css';/);
    assert.doesNotMatch(layout, /styles\/redesign\//);
    assert.doesNotMatch(layout, /styles\/render\/primitives\.css/);
  });

  it('imports the app CSS in cascade order and never in @layer', () => {
    const entry = read('src/styles/index.css');
    // Regression guard: `index.html` inlines unlayered critical CSS, and
    // unlayered declarations always beat layered ones. Wrapping the app CSS in
    // `@layer` silently drops the skin back to the critical CSS values, so the
    // entry must stay unlayered.
    assert.doesNotMatch(entry, /@layer\s+legacy/);
    assert.doesNotMatch(entry, /layer\(legacy\)|layer\(primitives\)/);
    assert.match(entry, /@import ['"]\.\/main\.css['"];/);
    assert.match(entry, /@import ['"]\.\/redesign\/foundation\.css['"];/);
    assert.match(entry, /@import ['"]\.\/legacy\/theme\.css['"];/);
    assert.match(entry, /@import ['"]\.\/legacy\/overrides\.css['"];/);
    assert.match(entry, /@import ['"]\.\/render\/primitives\.css['"];/);

    const foundation = entry.indexOf('./redesign/foundation.css');
    const main = entry.indexOf('./main.css');
    const theme = entry.indexOf('./legacy/theme.css');
    const overrides = entry.indexOf('./legacy/overrides.css');
    const primitives = entry.indexOf('./render/primitives.css');

    assert.ok(foundation < main, 'redesign feature CSS must load before the legacy skin');
    assert.ok(main < theme, 'legacy tokens must load after main.css');
    assert.ok(theme < overrides, 'legacy overrides must follow the token layer');
    assert.ok(overrides < primitives, 'primitives must load last so they can override legacy rules in source order');
  });
});
