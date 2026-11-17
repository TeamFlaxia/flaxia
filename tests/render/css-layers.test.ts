import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('styles/css-layers', () => {
  it('loads the app through one layered stylesheet entry', () => {
    const main = read('src/main.ts');
    assert.match(main, /import '\.\/styles\/index\.css';/);
    assert.doesNotMatch(main, /styles\/redesign\//);
    assert.doesNotMatch(main, /styles\/render\/primitives\.css/);
  });

  it('keeps legacy CSS before primitives in layer order', () => {
    const entry = read('src/styles/index.css');
    assert.match(entry, /@layer legacy, primitives;/);
    assert.match(entry, /@import ['"]\.\/main\.css['"] layer\(legacy\);/);
    assert.match(entry, /@import ['"]\.\/redesign\/foundation\.css['"] layer\(legacy\);/);
    assert.match(entry, /@import ['"]\.\/render\/primitives\.css['"] layer\(primitives\);/);
    assert.ok(
      entry.indexOf('layer(legacy)') < entry.indexOf('layer(primitives)'),
      'legacy must be imported before primitives',
    );
  });
});
