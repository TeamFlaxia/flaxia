import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createDownloadPage } from '../../src/components/DownloadPage.ts';

describe('DownloadPage', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // The Windows card probes the latest GitHub release. Keep unit tests offline.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ assets: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the three platform cards and the recommended state', () => {
    const page = createDownloadPage({ device: 'linux' });
    const element = page.getElement();

    assert.ok(element.classList.contains('download-page'));
    assert.equal(element.querySelectorAll('.download-card').length, 3);
    assert.equal(element.querySelectorAll('.download-card--recommended').length, 1);
    assert.equal(element.querySelector('.download-card--recommended')?.getAttribute('data-platform'), 'linux');
    assert.ok(element.querySelector('.download-hero'));
    assert.ok(element.querySelector('.download-all-releases'));
    assert.ok(element.querySelector('.download-footnote'));

    page.destroy();
    assert.equal(element.childNodes.length, 0);
  });

  it('orders the current platform first', () => {
    const page = createDownloadPage({ device: 'android' });
    const element = page.getElement();
    const platforms = [...element.querySelectorAll<HTMLElement>('.download-card')].map((card) =>
      card.getAttribute('data-platform'),
    );

    assert.equal(platforms[0], 'android');
    assert.equal(element.querySelector('.download-card--recommended')?.getAttribute('data-platform'), 'android');
    page.destroy();
  });
});
