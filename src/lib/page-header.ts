export interface PageHeaderOptions {
  title: string;
  subtitle?: string;
  subtitleRef?: (el: HTMLElement) => void;
  onBack?: () => void;
  actions?: HTMLElement[];
  titleSize?: string;
}

export function createPageHeader(options: PageHeaderOptions): HTMLElement {
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 1rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg-primary);
  `;

  if (options.onBack) {
    const backBtn = document.createElement('button');
    backBtn.textContent = '←';
    backBtn.style.cssText = `
      background: none;
      border: none;
      font-size: 1.25rem;
      cursor: pointer;
      color: var(--text-primary);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      transition: background 0.2s;
      flex-shrink: 0;
    `;
    backBtn.addEventListener('mouseenter', () => {
      backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
    });
    backBtn.addEventListener('mouseleave', () => {
      backBtn.style.background = 'none';
    });
    backBtn.addEventListener('click', options.onBack);
    header.appendChild(backBtn);
  }

  const titleSection = document.createElement('div');
  titleSection.style.cssText = 'display: flex; flex-direction: column;';

  const titleEl = document.createElement('h1');
  titleEl.textContent = options.title;
  titleEl.style.cssText = `
    margin: 0;
    font-size: ${options.titleSize ?? '1.25rem'};
    font-weight: 700;
    color: var(--text-primary);
  `;
  titleSection.appendChild(titleEl);

  if (options.subtitle) {
    const subtitleEl = document.createElement('span');
    subtitleEl.textContent = options.subtitle;
    subtitleEl.style.cssText = `
      font-size: 0.8rem;
      color: var(--text-muted);
    `;
    titleSection.appendChild(subtitleEl);
    options.subtitleRef?.(subtitleEl);
  }

  header.appendChild(titleSection);

  if (options.actions) {
    for (const action of options.actions) {
      header.appendChild(action);
    }
  }

  return header;
}
