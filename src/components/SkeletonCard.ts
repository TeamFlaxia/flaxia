import { html, mount } from '../lib/render/index.ts';

export function createSkeletonCard(): HTMLElement {
  const container = document.createElement('article');
  container.className = 'skeleton-card';
  // Decorative loading placeholder: hide it from assistive tech.
  container.setAttribute('aria-hidden', 'true');

  mount(
    container,
    () => html`
      <div class="skeleton-header">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-user">
          <div class="skeleton-line skeleton-line--name"></div>
          <div class="skeleton-line skeleton-line--time"></div>
        </div>
      </div>
      <div class="skeleton-text">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line skeleton-line--short"></div>
      </div>
      <div class="skeleton-media"></div>
      <div class="skeleton-actions">
        <div class="skeleton-action"></div>
        <div class="skeleton-action"></div>
        <div class="skeleton-action"></div>
      </div>
    `,
  );

  return container;
}

export function createSkeletonPost(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'skeleton-post';
  mount(container, () => html`${Array.from({ length: 3 }, () => createSkeletonCard())}`);
  return container;
}
