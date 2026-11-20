import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FOOTER_PAGES, preferredFile, preferredTitle } from '../../src/lib/docs/manifest.ts';

describe('DocsPage manifest helpers', () => {
  const doc = {
    slug: 'guide',
    title: { ja: 'ガイド', en: 'Guide' },
    files: { ja: 'guide.ja.md', en: 'guide.en.md' },
  };

  it('picks the preferred locale with fallbacks', () => {
    assert.equal(preferredTitle(doc, 'ja'), 'ガイド');
    assert.equal(preferredTitle(doc, 'de'), 'ガイド');
    assert.equal(preferredFile(doc, 'en'), 'guide.en.md');
    assert.equal(preferredFile(doc, 'de'), 'guide.en.md');
  });

  it('falls back to the slug when a title is missing', () => {
    assert.equal(preferredTitle({ slug: 'plain', title: {}, files: {} }, 'ja'), 'plain');
    assert.equal(preferredFile({ slug: 'plain', title: {}, files: {} }, 'ja'), '');
  });

  it('lists the five legal-footer destinations', () => {
    assert.deepEqual(
      FOOTER_PAGES.map((page) => page.path),
      ['/about', '/terms', '/privacy', '/docs/whitepaper', '/docs'],
    );
  });
});
