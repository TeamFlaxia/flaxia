import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSkeletonCard, createSkeletonPost } from '../../src/components/SkeletonCard.ts';

describe('SkeletonCard', () => {
  it('renders the reserved skeleton structure', () => {
    const card = createSkeletonCard();

    assert.ok(card.classList.contains('skeleton-card'));
    assert.equal(card.getAttribute('aria-hidden'), 'true');
    assert.equal(card.querySelectorAll('.skeleton-line').length, 5);
    assert.equal(card.querySelectorAll('.skeleton-line--short').length, 1);
    assert.ok(card.querySelector('.skeleton-media'));
    assert.equal(card.querySelectorAll('.skeleton-action').length, 3);
  });

  it('renders a group of three cards', () => {
    const post = createSkeletonPost();
    assert.ok(post.classList.contains('skeleton-post'));
    assert.equal(post.querySelectorAll('.skeleton-card').length, 3);
  });
});
