import assert from 'node:assert';
import { describe, it } from 'node:test';
import { renderUserTitle } from '../src/lib/render-html.ts';
import { isTitleIconImage } from '../src/lib/title-icon.ts';

describe('title icons', () => {
  it('detects image icons without treating emoji as URLs', () => {
    assert.equal(isTitleIconImage('/icons/flaxian.png'), true);
    assert.equal(isTitleIconImage('https://example.com/icon.png'), true);
    assert.equal(isTitleIconImage('🌿'), false);
    assert.equal(isTitleIconImage(null), false);
  });

  it('renders an image icon in SSR', () => {
    const html = renderUserTitle('Budding Flaxian', '/icons/flaxian.png', 'Created a Flaxia account.');
    assert.match(html, /<img class="ssr-user-title-icon" src="\/icons\/flaxian\.png"/);
    assert.match(html, /Budding Flaxian/);
  });

  it('renders a textual icon in SSR', () => {
    const html = renderUserTitle('Test Title', '🧪');
    assert.match(html, /<span aria-hidden="true">🧪<\/span>/);
  });
});
