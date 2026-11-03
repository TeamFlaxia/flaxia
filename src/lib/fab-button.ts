import { t } from './i18n.js';
import { icon } from './icons.js';

export function createFabButton(onClick: () => void, alwaysVisible = false): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `timeline-fab${alwaysVisible ? ' visible' : ''}`;
  btn.setAttribute('aria-label', t('composer.post_button'));
  btn.appendChild(icon('edit', { width: '24', height: '24' }));
  btn.addEventListener('click', onClick);
  return btn;
}
