import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('render/guards', () => {
  it('never blanks #app or restores the full-page loader', () => {
    const main = read('src/main.ts');
    assert.doesNotMatch(main, /app\.innerHTML\s*=\s*['"]{2}/);
    assert.doesNotMatch(main, /showPageLoader\s*\(/);
    assert.doesNotMatch(main, /hidePageLoader\s*\(/);
  });

  it('keeps the parked-view and staging paths in place', () => {
    const main = read('src/main.ts');
    assert.match(main, /appRoot\.replaceChildren\(\.\.\.staging\.childNodes\)/);
    assert.match(main, /function parkCurrentView\(/);
    assert.match(main, /function restoreParkedView\(/);
  });

  it('keeps Flaxia behind the package boundary', () => {
    const shim = read('src/lib/render/index.ts');
    assert.match(shim, /packages\/flaxia-render\/src\/index\.ts/);
    assert.doesNotMatch(shim, /from '\.\/signal\.ts'/);
  });
});
