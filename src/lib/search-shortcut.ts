// ⌘K / Ctrl-K focuses the search field instead of opening a modal.
//
// The right rail owns the search on desktop; below 1024px it is hidden, so the
// shortcut falls back to the Explore page and focuses its search input.
import { isApplePlatform } from './shortcut-label.js';

const SEARCH_SELECTORS = [
  '.right-panel .search-input',
  '.explore-search-section .search-input',
  '.search-page .search-input',
];

/** Focus the first visible search field. Returns false when none is mounted. */
export function focusSearchInput(): boolean {
  for (const selector of SEARCH_SELECTORS) {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (!input || input.offsetParent === null) continue;
    input.focus({ preventScroll: true });
    input.select();
    return true;
  }
  return false;
}

/**
 * Install the ⌘K / Ctrl-K handler. `openSearch` is called when no search field
 * is on screen; it should navigate to the Explore page.
 */
export function initSearchShortcut(openSearch: () => void): void {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const modifier = isApplePlatform() ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    if (focusSearchInput()) return;
    openSearch();
  });
}
