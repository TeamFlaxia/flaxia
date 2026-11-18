import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createDataSaverPlaceholder } from '../../src/lib/data-saver.ts';
import { loadLinkPreview } from '../../src/lib/link-preview.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('media reserved boxes', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('gives the data-saver gate the same 16:9 fx-box as the media it replaces', () => {
    const placeholder = createDataSaverPlaceholder('Load', () => {});

    assert.ok(placeholder.classList.contains('fx-box'));
    assert.ok(placeholder.classList.contains('data-saver-placeholder'));
    assert.match(placeholder.style.cssText, /--fx-ratio:\s*16\s*\/\s*9/);
    assert.doesNotMatch(placeholder.style.cssText, /padding-bottom/);
    assert.doesNotMatch(placeholder.style.cssText, /aspect-ratio/);
  });

  it('reserves link preview thumbnails with fx-box instead of padding-bottom', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          url: 'https://example.com/article',
          title: 'Example',
          description: 'Body',
          image: 'https://example.com/og.png',
          site_name: 'Example',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    const container = document.createElement('div');
    loadLinkPreview('https://example.com/article', container, true);

    const skeleton = container.querySelector('.post-link-preview-skeleton');
    assert.ok(skeleton, 'skeleton should reserve height while the fetch is in flight');

    await tick();
    await tick();

    const imageBox = container.querySelector<HTMLElement>('.link-preview-image-container');
    assert.ok(imageBox, 'thumbnail container should render');
    assert.ok(imageBox.classList.contains('fx-box'));
    assert.match(imageBox.style.cssText, /--fx-ratio:\s*1\.914/);
    assert.doesNotMatch(imageBox.style.cssText, /padding-bottom/);
    assert.equal(container.querySelector('.post-link-preview-skeleton'), null);
  });
});
