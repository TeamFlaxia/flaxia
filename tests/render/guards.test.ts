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

describe('render/media-box-guards', () => {
  it('reserves media ratios with fx-box instead of padding tricks', () => {
    const saver = read('src/lib/data-saver.ts');
    assert.match(saver, /data-saver-placeholder fx-box/);
    assert.match(saver, /--fx-ratio:\s*16\s*\/\s*9/);
    assert.doesNotMatch(saver, /padding-bottom/);

    const linkPreview = read('src/lib/link-preview.ts');
    assert.match(linkPreview, /--fx-ratio:\s*1\.914/);
    assert.match(linkPreview, /imgContainer\.classList\.add\('fx-box'\)/);
    assert.doesNotMatch(linkPreview, /padding-bottom/);

    const carousel = read('src/components/MediaCarousel.ts');
    assert.match(carousel, /slide\.classList\.add\('fx-box'\)/);

    const imagePreview = read('src/components/ImagePreview.ts');
    assert.match(imagePreview, /container\.classList\.add\('fx-box'\)/);

    const stage = read('src/components/PostStage.ts');
    assert.match(stage, /--fx-ratio/);
  });
});
