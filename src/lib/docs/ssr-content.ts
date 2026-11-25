// SSR-safe content helpers for the docs and legal +page.ts loads.
//
// markdown-it is plain JS and runs in a Worker during SSR. It is configured
// with `html: false`, so raw HTML in the markdown is escaped, never emitted as
// tags, and links are restricted to http(s)/mailto/relative URLs. DOMPurify is
// deliberately absent here: it needs a DOM and would throw during SSR. The old
// client-only path sanitized *after* markdown-it; since markdown-it's output is
// already safe, rendering the same HTML on both sides cannot cause a hydration
// mismatch.
import MarkdownIt from 'markdown-it';
import { markdownToHtml } from '../legal/markdown.ts';
import { LEGAL_PAGES, type LegalPageType } from '../legal/pages.ts';
import { type DocEntry, type DocsManifest, preferredFile, preferredTitle } from './manifest.ts';

export const SITE_ORIGIN = 'https://flaxia.app';

export function siteCanonical(pathname: string): string {
  return `${SITE_ORIGIN}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

const markdownIt = new MarkdownIt({
  html: false,
  xhtmlOut: false,
  breaks: true,
  linkify: false,
  typographer: true,
});

function isSafeLink(url: string): boolean {
  const value = url.trim();
  if (!value || value.length > 2048) return false;
  // Control characters can be used to obscure a javascript: scheme.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  // javascript:, data:, vbscript: and friends must never become an href/src.
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}
markdownIt.validateLink = isSafeLink;

export function docsMarkdownToHtml(markdown: string): string {
  return markdownIt.render(markdown);
}

/** First prose paragraph with inline markdown removed, for meta descriptions. */
export function excerptFromMarkdown(markdown: string, maxLength = 160): string {
  const line = markdown
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(
      (part) =>
        part.length > 0 &&
        !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)/.test(part) &&
        !/^(?:\*\*)?(?:Effective Date|Last Updated)(?:\*\*)?:/i.test(part),
    );
  if (!line) return '';
  const text = line
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export async function fetchDocsManifest(fetchFn: typeof fetch): Promise<DocsManifest> {
  const response = await fetchFn('/docs/index.json');
  if (!response.ok) throw new Error('Failed to load docs index');
  const manifest = (await response.json()) as DocsManifest;
  if (!Array.isArray(manifest?.docs)) throw new Error('Invalid docs index');
  return manifest;
}

export function findDoc(manifest: DocsManifest, slug: string): DocEntry | undefined {
  return manifest.docs.find((entry) => entry.slug === slug);
}

export interface DocsIndexContent {
  kind: 'index';
  title: string;
  description: string;
  canonical: string;
  docs: Array<{ slug: string; title: string }>;
  bodyHtml: '';
}

export interface DocsArticleContent {
  kind: 'article';
  slug: string;
  title: string;
  description: string;
  canonical: string;
  bodyHtml: string;
}

export type DocsPageContent = DocsIndexContent | DocsArticleContent;

export function buildDocsIndexContent(manifest: DocsManifest, locale: string, title: string): DocsIndexContent {
  return {
    kind: 'index',
    title,
    description: `${title} - guides, technical whitepaper and licence information for Flaxia.`,
    canonical: siteCanonical('/docs'),
    docs: manifest.docs.map((entry) => ({ slug: entry.slug, title: preferredTitle(entry, locale) })),
    bodyHtml: '',
  };
}

export function buildDocsArticleContent(
  slug: string,
  doc: DocEntry,
  locale: string,
  markdown: string,
): DocsArticleContent {
  const title = preferredTitle(doc, locale);
  const excerpt = excerptFromMarkdown(markdown);
  return {
    kind: 'article',
    slug,
    title,
    description: excerpt || `${title} - Flaxia documentation`,
    canonical: siteCanonical(`/docs/${encodeURIComponent(slug)}`),
    bodyHtml: docsMarkdownToHtml(markdown),
  };
}

/**
 * `fetchLegalMarkdown` uses the global fetch, which cannot resolve a relative
 * URL inside a Worker. Mirror its URL contract with the request-scoped fetch
 * supplied by SvelteKit (serialized for hydration) and reuse the pure
 * `markdownToHtml` transform in `buildLegalContent` below.
 */
export async function fetchLegalMarkdownForLoad(
  fetchFn: typeof fetch,
  fileName: string,
  locale: string,
): Promise<string> {
  const response = await fetchFn(`/legal/${fileName}.${locale}.md`);
  if (!response.ok) throw new Error('Failed to load');
  return response.text();
}

export interface LegalArticleContent {
  title: string;
  description: string;
  canonical: string;
  effectiveDate: string | null;
  bodyHtml: string;
}

export function buildLegalContent(
  type: LegalPageType,
  locale: string,
  markdown: string,
  title: string,
): LegalArticleContent {
  const effectiveDate =
    markdown.match(/^\s*(?:\*\*)?Effective Date(?:\*\*)?:\*{0,2}\s*([^\n*]+)/im)?.[1]?.trim() ?? null;
  const body = markdown.replace(/^\s*(?:\*\*)?Effective Date(?:\*\*)?:\*{0,2}[^\n]*\n?/im, '').trim();
  const excerpt = excerptFromMarkdown(body);
  return {
    title,
    description: excerpt || `${title} - Flaxia official policy (${locale})`,
    canonical: siteCanonical(LEGAL_PAGES[type].path),
    effectiveDate,
    bodyHtml: markdownToHtml(body),
  };
}

// Kept as an explicit re-export so the pure file-picking helpers stay in one
// place while every load uses the same locale rules.
export { preferredFile, preferredTitle };
