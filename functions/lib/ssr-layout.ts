import { escapeHtml, renderJsonLd } from '../../src/lib/render-html';

export interface BreadcrumbItem {
  label: string;
  url: string;
}

export interface SsrHeaderOptions {
  baseUrl: string;
  current?: 'home' | 'explore' | 'arcade';
  breadcrumb?: BreadcrumbItem[];
}

const NAV_ITEMS: Array<{ key: SsrHeaderOptions['current']; label: string; url: string }> = [
  { key: 'home', label: 'Home', url: '/home' },
  { key: 'explore', label: 'Explore', url: '/explore' },
  { key: 'arcade', label: 'Arcade', url: '/arcade' },
];

export function renderSsrHeader(options: SsrHeaderOptions): string {
  const { baseUrl, current, breadcrumb } = options;

  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${escapeHtml(baseUrl + item.url)}" class="ssr-nav-link${item.key === current ? ' active' : ''}">${escapeHtml(item.label)}</a>`,
  ).join('\n          ');

  const breadcrumbHtml =
    breadcrumb && breadcrumb.length > 0
      ? `<nav class="ssr-breadcrumb" aria-label="Breadcrumb"><ol>
        ${breadcrumb
          .map((item, index) => {
            const isLast = index === breadcrumb.length - 1;
            const li = isLast
              ? `<li aria-current="page">${escapeHtml(item.label)}</li>`
              : `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.label)}</a></li>`;
            return `          ${li}`;
          })
          .join('\n')}
        </ol></nav>`
      : '';

  return `
    <header class="ssr-header">
      <div class="ssr-header-brand">
        <a href="${escapeHtml(baseUrl)}" class="ssr-logo">Flaxia</a>
        ${breadcrumbHtml}
      </div>
      <nav class="ssr-nav" aria-label="Main navigation">
        ${nav}
      </nav>
    </header>`;
}

export interface SsrFooterLink {
  label: string;
  url: string;
}

export interface SsrFooterSection {
  title: string;
  links: SsrFooterLink[];
}

export interface SsrFooterOptions {
  baseUrl: string;
  sections?: SsrFooterSection[];
}

export function renderSsrFooter(options: SsrFooterOptions): string {
  const { baseUrl, sections = [] } = options;

  const siteLinks: SsrFooterLink[] = [
    { label: 'Home', url: `${baseUrl}/home` },
    { label: 'Explore', url: `${baseUrl}/explore` },
    { label: 'Arcade', url: `${baseUrl}/arcade` },
    { label: 'About', url: `${baseUrl}/about` },
    { label: 'Legal', url: `${baseUrl}/legal` },
  ];

  const sectionHtml = sections
    .map(
      (section) => `<div class="ssr-footer-col">
        <h3>${escapeHtml(section.title)}</h3>
        <ul>${section.links
          .map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></li>`)
          .join('')}</ul>
      </div>`,
    )
    .join('\n        ');

  return `
    <footer class="ssr-footer">
      <div class="ssr-footer-grid">
        <div class="ssr-footer-col">
          <h3>Flaxia</h3>
          <ul>${siteLinks
            .map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></li>`)
            .join('')}</ul>
        </div>
        ${sectionHtml}
      </div>
      <div class="ssr-footer-bottom">
        <a href="${escapeHtml(baseUrl)}">← Back to Flaxia</a>
      </div>
    </footer>`;
}

export function renderBreadcrumbJsonLd(items: BreadcrumbItem[], baseUrl: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: item.url.startsWith('http') ? item.url : `${baseUrl}${item.url}`,
    })),
  });
}

export function renderSsrLayoutCss(): string {
  return `
    <style>
      .ssr-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .ssr-header-brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .ssr-nav {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ssr-nav-link {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 13px;
        color: var(--text-muted);
        text-decoration: none;
      }
      .ssr-nav-link:hover { color: var(--text-primary); background: var(--bg-input); }
      .ssr-nav-link.active {
        color: #fff;
        background: #007bff;
        font-weight: 600;
      }
      .ssr-breadcrumb ol {
        display: flex;
        align-items: center;
        gap: 6px;
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: 13px;
        color: var(--text-muted);
      }
      .ssr-breadcrumb li { display: inline-flex; align-items: center; }
      .ssr-breadcrumb li:not(:last-child)::after { content: '›'; margin-left: 6px; color: #bbb; }
      .ssr-breadcrumb a { color: #007bff; text-decoration: none; }
      .ssr-breadcrumb a:hover { text-decoration: underline; }
      .ssr-breadcrumb li[aria-current="page"] { color: var(--text-primary); font-weight: 600; }
      .ssr-footer-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 24px;
        max-width: 720px;
        margin: 0 auto 16px;
        text-align: left;
      }
      .ssr-footer-col h3 {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
        margin: 0 0 8px 0;
      }
      .ssr-footer-col ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .ssr-footer-col li { margin-bottom: 4px; }
      .ssr-footer-col a { color: #007bff; text-decoration: none; font-size: 13px; }
      .ssr-footer-col a:hover { text-decoration: underline; }
      .ssr-footer-bottom { margin-top: 8px; }
    </style>`;
}
