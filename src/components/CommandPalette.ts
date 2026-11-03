/**
 * Command palette (⌘K / Ctrl+K) — Obsidian-inspired quick switcher with a
 * shadcn-style command menu. Actions are supplied by main.ts so this module
 * stays free of routing/auth imports.
 */

import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { isApplePlatform } from '../lib/shortcut-label.js';

export interface CommandAction {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

type ActionProvider = () => CommandAction[];

let provider: ActionProvider | null = null;
let overlay: HTMLElement | null = null;
let dialog: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;
let actions: CommandAction[] = [];
let filtered: CommandAction[] = [];
let selected = 0;
let previouslyFocused: HTMLElement | null = null;
let unregisterModal: (() => void) | null = null;
let closeTimer: number | undefined;

export function registerCommandActions(next: ActionProvider): void {
  provider = next;
}

let initialized = false;

/** Install the global shortcut and the trigger event listener once. */
export function initCommandPalette(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener('keydown', (event) => {
    if (event.isComposing) return;

    if (overlay && overlay.hidden === false) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommandPalette();
      } else if (event.key === 'Tab') {
        // Focus stays in the search field; the list is driven with the arrow
        // keys and aria-activedescendant so the dialog cannot leak focus.
        event.preventDefault();
        input?.focus();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        selected = Math.min(filtered.length - 1, selected + 1);
        updateSelection();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        selected = Math.max(0, selected - 1);
        updateSelection();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        runSelected();
      }
      return;
    }

    const modifier = isApplePlatform() ? event.metaKey : event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
    }
  });

  window.addEventListener('flaxia:command', () => openCommandPalette());
}

function matches(action: CommandAction, query: string): boolean {
  if (!query) return true;
  const hay = `${action.label} ${action.group} ${action.keywords ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

function render(): void {
  if (!list) return;
  const query = input?.value.trim() ?? '';
  filtered = (provider?.() ?? actions).filter((action) => matches(action, query));
  if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
  list.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = t('command.empty');
    list.appendChild(empty);
    updateActiveDescendant();
    return;
  }

  let currentGroup = '';
  filtered.forEach((action, index) => {
    if (action.group !== currentGroup) {
      currentGroup = action.group;
      const label = document.createElement('div');
      label.className = 'cmd-group';
      label.textContent = action.group;
      list?.appendChild(label);
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cmd-item';
    item.id = `cmd-item-${index}`;
    item.tabIndex = -1;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === selected));
    item.dataset.index = String(index);
    if (index === selected) item.classList.add('is-selected');

    const label = document.createElement('span');
    label.className = 'cmd-item-label';
    label.textContent = action.label;
    item.appendChild(label);

    if (action.hint) {
      const hint = document.createElement('kbd');
      hint.className = 'cmd-kbd';
      hint.textContent = action.hint;
      item.appendChild(hint);
    }

    item.addEventListener('mouseenter', () => {
      selected = index;
      updateSelection();
    });
    item.addEventListener('click', () => runSelected(index));
    list?.appendChild(item);
  });

  updateActiveDescendant();
  scrollSelectedIntoView();
}

function updateSelection(): void {
  if (!list) return;
  const items = list.querySelectorAll<HTMLElement>('.cmd-item');
  items.forEach((item) => {
    const active = Number(item.dataset.index) === selected;
    item.classList.toggle('is-selected', active);
    item.setAttribute('aria-selected', String(active));
  });
  updateActiveDescendant();
  scrollSelectedIntoView();
}

function updateActiveDescendant(): void {
  if (!input) return;
  if (filtered.length === 0) {
    input.removeAttribute('aria-activedescendant');
    return;
  }
  input.setAttribute('aria-activedescendant', `cmd-item-${selected}`);
}

function scrollSelectedIntoView(): void {
  if (!list) return;
  const active = list.querySelector<HTMLElement>('.cmd-item.is-selected');
  active?.scrollIntoView({ block: 'nearest' });
}

function runSelected(index = selected): void {
  const action = filtered[index];
  if (!action) return;
  closeCommandPalette();
  action.run();
}

export function openCommandPalette(): void {
  if (!provider) return;
  if (!overlay) build();
  if (!overlay || !dialog || !input) return;

  if (overlay.hidden === false) {
    input.focus({ preventScroll: true });
    return;
  }

  if (closeTimer !== undefined) {
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  if (!unregisterModal) unregisterModal = registerModal();
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  actions = provider();
  selected = 0;
  input.value = '';
  render();
  overlay.hidden = false;
  requestAnimationFrame(() => {
    overlay?.classList.add('is-open');
    dialog?.classList.add('is-open');
    input?.focus({ preventScroll: true });
  });
}

export function closeCommandPalette(): void {
  if (!overlay || overlay.hidden) return;
  overlay.classList.remove('is-open');
  dialog?.classList.remove('is-open');
  unregisterModal?.();
  unregisterModal = null;
  if (closeTimer !== undefined) window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    closeTimer = undefined;
    if (overlay) overlay.hidden = true;
    previouslyFocused?.focus?.({ preventScroll: true });
    previouslyFocused = null;
  }, 140);
}

function build(): void {
  overlay = document.createElement('div');
  overlay.className = 'cmd-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'presentation');

  dialog = document.createElement('div');
  dialog.className = 'cmd-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', t('command.title'));

  const searchRow = document.createElement('div');
  searchRow.className = 'cmd-search';

  const icon = document.createElement('span');
  icon.className = 'cmd-search-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>';

  input = document.createElement('input');
  input.className = 'cmd-input';
  input.type = 'text';
  input.placeholder = t('command.search_placeholder');
  input.setAttribute('aria-label', t('command.search_placeholder'));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'cmd-list');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const esc = document.createElement('kbd');
  esc.className = 'cmd-kbd';
  esc.textContent = 'Esc';

  searchRow.appendChild(icon);
  searchRow.appendChild(input);
  searchRow.appendChild(esc);

  list = document.createElement('div');
  list.id = 'cmd-list';
  list.className = 'cmd-list';
  list.setAttribute('role', 'listbox');

  const footer = document.createElement('div');
  footer.className = 'cmd-footer';
  footer.innerHTML =
    `<span><kbd class="cmd-kbd">↑</kbd><kbd class="cmd-kbd">↓</kbd> ${t('command.move')}</span>` +
    `<span><kbd class="cmd-kbd">↵</kbd> ${t('command.run')}</span>` +
    `<span><kbd class="cmd-kbd">esc</kbd> ${t('command.close')}</span>`;

  dialog.appendChild(searchRow);
  dialog.appendChild(list);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeCommandPalette();
  });

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });
}
