export interface PageHeaderOptions {
  title: string;
  subtitle?: string;
  subtitleRef?: (el: HTMLElement) => void;
  onBack?: () => void;
  actions?: HTMLElement[];
  titleSize?: string;
}

/**
 * Sticky glass page header used by list/detail pages that are not part of the
 * three-column shell (bookmarks, notifications, tag explore, ...).
 *
 * Presentation lives in src/styles/redesign/shell.css (.page-header*); this
 * module only builds structure, so the header stays themeable and no inline
 * colours leak into the new token system.
 */
export function createPageHeader(options: PageHeaderOptions): HTMLElement {
  const header = document.createElement('div');
  header.className = 'page-header';

  if (options.titleSize) {
    header.style.setProperty('--page-header-title-size', options.titleSize);
  }

  if (options.onBack) {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'page-header-back';
    backBtn.textContent = '←';
    backBtn.setAttribute('aria-label', 'Back');
    backBtn.addEventListener('click', options.onBack);
    header.appendChild(backBtn);
  }

  const titleSection = document.createElement('div');
  titleSection.className = 'page-header-titles';

  const titleEl = document.createElement('h1');
  titleEl.className = 'page-header-title fx-display';
  titleEl.textContent = options.title;
  titleSection.appendChild(titleEl);

  if (options.subtitle) {
    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'page-header-subtitle';
    subtitleEl.textContent = options.subtitle;
    titleSection.appendChild(subtitleEl);
    options.subtitleRef?.(subtitleEl);
  }

  header.appendChild(titleSection);

  if (options.actions && options.actions.length > 0) {
    const actionRow = document.createElement('div');
    actionRow.className = 'page-header-actions';
    for (const action of options.actions) {
      actionRow.appendChild(action);
    }
    header.appendChild(actionRow);
  }

  return header;
}
