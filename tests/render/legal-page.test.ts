import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdownToHtml } from '../../src/lib/legal/markdown.ts';
import { ALL_PAGES, LEGAL_PAGES } from '../../src/lib/legal/pages.ts';

describe('LegalPage content', () => {
  it('exposes the four legal routes with stable paths', () => {
    assert.deepEqual(
      ALL_PAGES.map((page) => page.path),
      ['/terms', '/privacy', '/child-safety', '/about'],
    );
    for (const type of ['terms', 'privacy', 'child-safety', 'about'] as const) {
      assert.ok(LEGAL_PAGES[type].fileName, type);
      assert.ok(LEGAL_PAGES[type].titleKey, type);
    }
  });

  it('escapes raw HTML before emitting tags', () => {
    const html = markdownToHtml('<script>alert(1)</script> **bold**');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('<strong>bold</strong>'));
  });

  it('renders headings, code, links and effective dates from markdown', () => {
    const html = markdownToHtml(
      '# Test Title\n\nEffective Date: 2026-01-01\n\nBody **bold** and `code`. [link](https://example.com)',
    );
    assert.match(html, /<h1>Test Title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
  });
});
