import { createSkeletonCard } from '../components/SkeletonCard.js';
import { t } from './i18n.js';

export function createSkeletonCards(count: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    fragment.appendChild(createSkeletonCard());
  }
  return fragment;
}

export function createLoadingSpinner(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'loading-spinner';
  container.style.display = 'none';

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const label = document.createElement('span');
  label.textContent = t('common.loading');

  container.appendChild(spinner);
  container.appendChild(label);

  return container;
}
