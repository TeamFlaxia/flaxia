// Keyboard shortcut sheet — the help card's "基本操作・ショートカット" entry.
//
// The command palette is gone, but the bindings it advertised (N, T,
// Alt+1/2/3, ⌘K) are still live, so they get a plain, readable list instead.
import { t } from './i18n.js';
import { createModalOverlay } from './modal-overlay.js';
import { commandShortcutLabel } from './shortcut-label.js';

export function openShortcutSheet(): void {
  const { overlay, dialog, close } = createModalOverlay('420px', { label: t('shortcuts.title') });

  const title = document.createElement('h2');
  title.className = 'shortcut-sheet-title';
  title.textContent = t('shortcuts.title');

  const list = document.createElement('div');
  list.className = 'shortcut-sheet-list';

  const rows: Array<[string, string]> = [
    [commandShortcutLabel(), t('shortcuts.search')],
    ['N', t('shortcuts.new_post')],
    ['T', t('shortcuts.toggle_theme')],
    ['Alt+1/2/3', t('shortcuts.feed')],
  ];

  for (const [keys, text] of rows) {
    const row = document.createElement('div');
    row.className = 'shortcut-sheet-row';

    const label = document.createElement('span');
    label.className = 'shortcut-sheet-label';
    label.textContent = text;

    const kbd = document.createElement('kbd');
    kbd.className = 'shortcut-sheet-kbd';
    kbd.textContent = keys;

    row.appendChild(label);
    row.appendChild(kbd);
    list.appendChild(row);
  }

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'shortcut-sheet-close';
  closeButton.textContent = t('common.close');
  closeButton.addEventListener('click', close);

  dialog.appendChild(title);
  dialog.appendChild(list);
  dialog.appendChild(closeButton);

  document.body.appendChild(overlay);
}
