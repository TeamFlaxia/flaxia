import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.svelte')) out.push(full);
  }
  return out;
}

const ALL_SOURCE = sourceFiles(join(ROOT, 'src'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('render/guards', () => {
  it('never blanks #app or restores the full-page loader', () => {
    // These used to be checked against legacy main.ts. The whole app is now
    // Svelte-owned, so scan every source file to keep the regression covered.
    assert.doesNotMatch(ALL_SOURCE, /app\.innerHTML\s*=\s*['"]{2}/);
    assert.doesNotMatch(ALL_SOURCE, /showPageLoader\s*\(/);
    assert.doesNotMatch(ALL_SOURCE, /hidePageLoader\s*\(/);
  });

  it('no longer relies on the legacy parked-view staging path', () => {
    // main.ts owned a parked-view/staging mechanism that hid a cached view in
    // #app-parking. Every view now has its own Svelte route, so that mechanism
    // is intentionally gone.
    assert.doesNotMatch(ALL_SOURCE, /appRoot\.replaceChildren\(\.\.\.staging\.childNodes\)/);
    assert.doesNotMatch(ALL_SOURCE, /function parkCurrentView\(/);
    assert.doesNotMatch(ALL_SOURCE, /function restoreParkedView\(/);
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

describe('render/settings-guards', () => {
  it('builds the settings forms through the engine, not innerHTML', () => {
    const settings = read('src/components/SettingsPage.ts');
    assert.match(settings, /html/);
    assert.match(settings, /const languageLocales = signal/);
    assert.match(settings, /displayMounts\.push\(/);
    assert.doesNotMatch(settings, /const languageSelect = document\.createElement/);
    assert.doesNotMatch(settings, /languageSelect\.innerHTML/);
  });
});
