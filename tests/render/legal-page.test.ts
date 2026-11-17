import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLegalPage } from '../../src/components/LegalPage.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('LegalPage', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('# Test Title\n\nEffective Date: 2026-01-01\n\nBody **bold** and `code`.', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown' },
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the loaded markdown inside the engine shell', async () => {
    const page = createLegalPage({ type: 'terms' });
    const element = page.getElement();
    await tick();
    await tick();

    assert.ok(element.classList.contains('legal-page'));
    assert.ok(element.querySelector('.legal-content-wrapper'));
    assert.equal(element.querySelector('.legal-title')?.textContent, 'legal.terms_title');
    assert.match(element.querySelector('.legal-effective-date')?.textContent ?? '', /legal\.effective_date/);
    assert.equal(element.querySelector('.legal-body h1')?.textContent, 'Test Title');
    assert.equal(element.querySelector('.legal-body strong')?.textContent, 'bold');
    assert.equal(element.querySelector('.legal-body code')?.textContent, 'code');
    assert.equal(element.querySelectorAll('.legal-footer-link').length, 4);

    page.destroy();
    assert.equal(element.childNodes.length, 0);
  });
});
