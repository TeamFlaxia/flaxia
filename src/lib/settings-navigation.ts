import { t } from './i18n.js';
import { type IconName, icon } from './icons.js';

interface SettingsCategory {
  id: string;
  groupKey: string;
  titleKey: string;
  descriptionKey: string;
  iconName: IconName;
  sections: HTMLElement[];
}

/** Keep settings forms mounted so navigating between categories preserves edits. */
export function createSettingsNavigation() {
  const container = document.createElement('div');
  container.className = 'settings-page';

  const header = document.createElement('header');
  header.className = 'settings-header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'settings-back';
  back.textContent = '←';
  back.setAttribute('aria-label', t('common.back'));
  const heading = document.createElement('h1');
  heading.textContent = t('settings.title');
  heading.tabIndex = -1;
  const breadcrumb = document.createElement('span');
  breadcrumb.className = 'settings-breadcrumb';
  breadcrumb.textContent = t('settings.title');
  breadcrumb.hidden = true;
  const titles = document.createElement('div');
  titles.appendChild(breadcrumb);
  titles.appendChild(heading);
  header.appendChild(back);
  header.appendChild(titles);

  const overview = document.createElement('div');
  overview.className = 'settings-overview';
  const introduction = document.createElement('p');
  introduction.className = 'settings-introduction';
  introduction.textContent = t('settings.introduction');
  overview.appendChild(introduction);
  const content = document.createElement('div');
  content.className = 'settings-content';
  content.hidden = true;
  container.appendChild(header);
  container.appendChild(overview);
  container.appendChild(content);

  const groups = new Map<string, HTMLElement>();
  const categories = new Map<string, { category: SettingsCategory; button: HTMLButtonElement; panel: HTMLElement }>();
  let activeCategory: string | null = null;
  let overviewScrollY = 0;

  function showCategory(id: string | null, moveFocus = true): void {
    const entry = id ? categories.get(id) : undefined;
    const previous = activeCategory;
    if (entry && !previous) overviewScrollY = window.scrollY;
    activeCategory = entry?.category.id ?? null;
    overview.hidden = !!entry;
    content.hidden = !entry;
    breadcrumb.hidden = !entry;
    heading.textContent = entry ? t(entry.category.titleKey) : t('settings.title');
    back.setAttribute('aria-label', t(entry ? 'settings.back_to_overview' : 'common.back'));
    for (const { category, panel } of categories.values()) {
      panel.hidden = category.id !== activeCategory;
    }
    if (moveFocus) {
      if (entry) {
        heading.focus({ preventScroll: true });
        container.scrollIntoView({ block: 'start', behavior: 'instant' });
      } else {
        categories.get(previous ?? '')?.button.focus({ preventScroll: true });
        window.scrollTo({ top: overviewScrollY, behavior: 'instant' });
      }
    }
  }

  back.addEventListener('click', () => {
    if (activeCategory) showCategory(null);
    else window.history.back();
  });

  function addCategory(category: SettingsCategory): void {
    let group = groups.get(category.groupKey);
    if (!group) {
      const section = document.createElement('section');
      section.className = 'settings-group';
      const title = document.createElement('h2');
      title.className = 'settings-group-title';
      title.textContent = t(category.groupKey);
      group = document.createElement('div');
      group.className = 'settings-category-list';
      section.appendChild(title);
      section.appendChild(group);
      overview.appendChild(section);
      groups.set(category.groupKey, group);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-category';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'settings-category-icon';
    iconWrap.appendChild(icon(category.iconName));
    const text = document.createElement('span');
    text.className = 'settings-category-text';
    const label = document.createElement('span');
    label.className = 'settings-category-label';
    label.textContent = t(category.titleKey);
    const description = document.createElement('span');
    description.className = 'settings-category-description';
    description.textContent = t(category.descriptionKey);
    text.appendChild(label);
    text.appendChild(description);
    const chevron = document.createElement('span');
    chevron.className = 'settings-category-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    button.appendChild(iconWrap);
    button.appendChild(text);
    button.appendChild(chevron);
    button.addEventListener('click', () => showCategory(category.id));
    group.appendChild(button);

    const panel = document.createElement('section');
    panel.className = 'settings-category-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', t(category.titleKey));
    const intro = document.createElement('p');
    intro.className = 'settings-panel-description';
    intro.textContent = t(category.descriptionKey);
    panel.appendChild(intro);
    for (const section of category.sections) panel.appendChild(section);
    content.appendChild(panel);
    categories.set(category.id, { category, button, panel });
  }

  return {
    getElement: () => container,
    getActiveCategory: () => activeCategory,
    showCategory,
    addCategory,
  };
}
