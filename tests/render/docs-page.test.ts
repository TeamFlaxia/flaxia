import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createDocsPage } from '../../src/components/DocsPage.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('DocsPage', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/docs/index.json')) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                slug: 'guide',
                title: { ja: 'Guide', en: 'Guide' },
                files: { ja: 'guide.md', en: 'guide.md' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('# Guide\n\nBody.', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the docs index inside the engine shell', async () => {
    const page = createDocsPage({});
    const element = page.getElement();
    await tick();
    await tick();

    assert.ok(element.classList.contains('docs-page'));
    assert.ok(element.querySelector('.legal-content-wrapper'));
    assert.equal(element.querySelectorAll('.docs-list-item').length, 1);
    assert.equal(element.querySelector('.docs-list-item')?.getAttribute('data-docs-slug'), 'guide');
    assert.equal(element.querySelector('.docs-list-title')?.textContent, 'Guide');
    assert.equal(element.querySelectorAll('.legal-footer-link').length, 5);

    page.destroy();
    assert.equal(element.childNodes.length, 0);
  });
});
