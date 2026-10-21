import DOMPurify from 'dompurify';
import type MarkdownIt from 'markdown-it';
import { getLocale, t } from '../lib/i18n.js';

interface DocsPageProps {
  slug?: string;
}

interface DocEntry {
  slug: string;
  title: Record<string, string>;
  files: Record<string, string>;
}

interface DocsManifest {
  docs: DocEntry[];
}

const LOCALES = ['ja', 'en'] as const;

const FOOTER_PAGES = [
  { path: '/about', key: 'legal.footer_about' },
  { path: '/terms', key: 'legal.footer_terms' },
  { path: '/privacy', key: 'legal.footer_privacy' },
  { path: '/docs/whitepaper', key: 'legal.footer_whitepaper' },
  { path: '/docs', key: 'legal.footer_docs' },
] as const;

let markdownItPromise: Promise<typeof import('markdown-it')> | null = null;

async function getMarkdownIt(): Promise<MarkdownIt> {
  if (!markdownItPromise) {
    markdownItPromise = import('markdown-it');
  }
  const MarkdownItModule = await markdownItPromise;
  return new MarkdownItModule.default({
    html: false,
    xhtmlOut: false,
    breaks: true,
    linkify: false,
    typographer: true,
  });
}

async function fetchManifest(): Promise<DocsManifest> {
  const response = await fetch('/docs/index.json');
  if (!response.ok) throw new Error('Failed to load docs index');
  return response.json();
}

function pickLocaleValue(map: Record<string, string>, fallbackOrder: readonly string[]): string | undefined {
  for (const key of fallbackOrder) {
    if (map[key]) return map[key];
  }
  const first = Object.keys(map)[0];
  return first ? map[first] : undefined;
}

function preferredTitle(doc: DocEntry, locale: string): string {
  const title = pickLocaleValue(doc.title, [locale, ...LOCALES, '']);
  return title || doc.slug;
}

function preferredFile(doc: DocEntry, locale: string): string {
  return pickLocaleValue(doc.files, [locale, 'en', 'ja', '']) || '';
}

function navigateTo(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function renderHeader(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'legal-header';
  header.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';

  const backBtn = document.createElement('button');
  backBtn.textContent = '←';
  backBtn.style.cssText =
    'background: none; border: none; font-size: 1.25rem; cursor: pointer; color: var(--text-primary); padding: 0.25rem 0.5rem; border-radius: 4px; transition: background 0.2s;';
  backBtn.addEventListener('mouseenter', () => {
    backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
  });
  backBtn.addEventListener('mouseleave', () => {
    backBtn.style.background = 'none';
  });
  backBtn.addEventListener('click', () => window.history.back());

  const wordmark = document.createElement('a');
  wordmark.href = '/';
  wordmark.className = 'legal-wordmark';
  wordmark.textContent = t('legal.brand');
  wordmark.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('/');
  });

  header.appendChild(backBtn);
  header.appendChild(wordmark);
  return header;
}

function renderFooter(): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'legal-footer';
  const footerLinks = document.createElement('div');
  footerLinks.className = 'legal-footer-links';

  FOOTER_PAGES.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'legal-footer-separator';
      sep.textContent = t('legal.footer_separator');
      footerLinks.appendChild(sep);
    }
    const link = document.createElement('a');
    link.href = p.path;
    link.textContent = t(p.key);
    link.className = 'legal-footer-link';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(p.path);
    });
    footerLinks.appendChild(link);
  });

  footer.appendChild(footerLinks);
  return footer;
}

function renderDocsList(container: HTMLElement, docs: DocEntry[]): void {
  const list = document.createElement('div');
  list.className = 'docs-list';

  for (const doc of docs) {
    const item = document.createElement('a');
    item.href = `/docs/${encodeURIComponent(doc.slug)}`;
    item.className = 'docs-list-item';
    item.setAttribute('data-docs-slug', doc.slug);

    const title = document.createElement('div');
    title.className = 'docs-list-title';
    title.textContent = preferredTitle(doc, getLocale());

    const arrow = document.createElement('span');
    arrow.className = 'docs-list-arrow';
    arrow.textContent = '→';

    item.appendChild(title);
    item.appendChild(arrow);

    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(`/docs/${encodeURIComponent(doc.slug)}`);
    });

    list.appendChild(item);
  }

  container.appendChild(list);
}

async function renderDocsArticle(container: HTMLElement, file: string): Promise<void> {
  const md = await getMarkdownIt();

  const bodyEl = document.createElement('div');
  bodyEl.className = 'legal-body docs-article-body';
  container.appendChild(bodyEl);

  try {
    const response = await fetch(`/docs/${encodeURIComponent(file)}`);
    if (!response.ok) throw new Error('Failed to load doc');
    const markdown = await response.text();
    const html = md.render(markdown);
    bodyEl.innerHTML = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'h1',
        'h2',
        'h3',
        'h4',
        'p',
        'br',
        'strong',
        'em',
        'code',
        'pre',
        'blockquote',
        'hr',
        'ul',
        'ol',
        'li',
        'a',
        'span',
        'table',
        'thead',
        'tbody',
        'tr',
        'td',
        'th',
        's',
        'del',
        'img',
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt', 'title', 'colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false,
    });
  } catch {
    const errorEl = document.createElement('div');
    errorEl.className = 'legal-error';
    errorEl.textContent = t('docs.load_failed');
    container.appendChild(errorEl);
  }
}

export function createDocsPage({ slug }: DocsPageProps) {
  const container = document.createElement('div');
  container.className = 'legal-page docs-page';

  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'legal-content-wrapper';

  const header = renderHeader();

  const content = document.createElement('article');
  content.className = 'legal-content';

  const loadContent = async () => {
    const titleEl = document.createElement('h1');
    titleEl.className = 'legal-title docs-title';
    titleEl.textContent = t('docs.title');
    content.appendChild(titleEl);

    try {
      const manifest = await fetchManifest();

      if (!slug) {
        renderDocsList(content, manifest.docs);
        return;
      }

      const doc = manifest.docs.find((d) => d.slug === slug);
      if (!doc) {
        const errorEl = document.createElement('div');
        errorEl.className = 'legal-error';
        errorEl.textContent = t('docs.not_found');
        content.appendChild(errorEl);
        return;
      }

      titleEl.textContent = preferredTitle(doc, getLocale());
      titleEl.classList.add('docs-article-title');
      titleEl.classList.remove('legal-title');

      const file = preferredFile(doc, getLocale());
      if (!file) {
        const errorEl = document.createElement('div');
        errorEl.className = 'legal-error';
        errorEl.textContent = t('docs.not_found');
        content.appendChild(errorEl);
        return;
      }

      await renderDocsArticle(content, file);
    } catch {
      const errorEl = document.createElement('div');
      errorEl.className = 'legal-error';
      errorEl.textContent = t('docs.load_failed');
      content.appendChild(errorEl);
    }
  };

  contentWrapper.appendChild(header);
  contentWrapper.appendChild(content);
  contentWrapper.appendChild(renderFooter());
  container.appendChild(contentWrapper);

  loadContent();

  return {
    getElement: () => container,
    destroy: () => {},
  };
}
