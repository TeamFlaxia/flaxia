// Data-saver media gating helpers (see src/lib/settings.ts for the toggle).
//
// When data-saver mode is on (manual toggle or browser Save-Data), media
// components show a tap-to-load placeholder instead of fetching bytes
// immediately. The real media is only created after the user taps.

import { t } from './i18n.js';

/**
 * Creates a tap-to-load placeholder that occupies the same 16:9 box as a
 * typical image/video preview. `onLoad` is invoked once on first tap; the
 * caller is expected to replace this element with the real media.
 */
export function createDataSaverPlaceholder(buttonLabel: string, onLoad: () => void): HTMLElement {
  const container = document.createElement('div');
  container.className = 'data-saver-placeholder';
  container.style.cssText = `
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--bg-input);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  `;

  const hint = document.createElement('div');
  hint.textContent = t('media.data_saver_placeholder');
  hint.style.cssText = 'text-align: center; padding: 0 1rem;';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = buttonLabel;
  button.style.cssText = `
    background: #22c55e;
    color: #052e16;
    border: 1px solid #16a34a;
    border-radius: 9999px;
    padding: 0.5rem 1.25rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 700;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  `;

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    button.disabled = true;
    onLoad();
  });

  container.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!button.disabled) button.click();
  });

  container.appendChild(hint);
  container.appendChild(button);
  return container;
}
