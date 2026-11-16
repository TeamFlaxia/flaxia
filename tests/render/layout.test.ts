import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MediaBox, Skeleton } from '../../src/lib/layout/box.ts';
import { html, mount } from '../../src/lib/render/index.ts';

function createRoot(): HTMLElement {
  return document.createElement('div');
}

describe('layout/box', () => {
  it('reserves an aspect-ratio box before its contents load', () => {
    const root = createRoot();
    mount(root, () => MediaBox({ ratio: '16 / 9', label: 'Thumbnail' }, () => html`<span>later</span>`));

    const box = root.querySelector<HTMLElement>('.fx-box');
    assert.ok(box);
    assert.equal(box.style.getPropertyValue('--fx-ratio'), '16 / 9');
    assert.equal(box.getAttribute('role'), 'group');
    assert.equal(box.getAttribute('aria-label'), 'Thumbnail');
    assert.equal(box.querySelector('.fx-box__inner span')?.textContent, 'later');
  });

  it('renders a skeleton with the same box contract', () => {
    const root = createRoot();
    mount(root, () => Skeleton({ ratio: '4 / 3' }));

    const box = root.querySelector<HTMLElement>('.fx-box.fx-skeleton');
    assert.ok(box);
    assert.equal(box.style.getPropertyValue('--fx-ratio'), '4 / 3');
    assert.equal(box.getAttribute('aria-hidden'), 'true');
  });
});
