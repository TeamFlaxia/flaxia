import { registerModal } from './modal-state.js';

export interface ModalOverlay {
  overlay: HTMLDivElement;
  dialog: HTMLDivElement;
  unregister: () => void;
  close: () => void;
}

export function createModalOverlay(dialogMaxWidth = '420px'): ModalOverlay {
  const unregister = registerModal();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 24px;
    max-width: ${dialogMaxWidth};
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  `;

  overlay.appendChild(dialog);

  const close = () => {
    unregister();
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, dialog, unregister, close };
}

export interface MenuItemConfig {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function createMenuItem(config: MenuItemConfig): HTMLButtonElement {
  const item = document.createElement('button');
  item.style.cssText = `
    display: block;
    width: 100%;
    padding: 10px 16px;
    background: none;
    border: none;
    color: ${config.danger ? 'var(--danger, #e74c3c)' : 'var(--text-primary)'};
    text-align: left;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.2s;
  `;
  item.textContent = config.label;
  item.addEventListener('mouseenter', () => {
    item.style.background = 'var(--bg-secondary)';
  });
  item.addEventListener('mouseleave', () => {
    item.style.background = 'none';
  });
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    config.onClick();
  });
  return item;
}
