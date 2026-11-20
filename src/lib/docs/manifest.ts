// Pure docs-manifest helpers shared by the Svelte docs page.
export interface DocEntry {
  slug: string;
  title: Record<string, string>;
  files: Record<string, string>;
}

export interface DocsManifest {
  docs: DocEntry[];
}

export const LOCALES = ['ja', 'en'] as const;

export const FOOTER_PAGES = [
  { path: '/about', key: 'legal.footer_about' },
  { path: '/terms', key: 'legal.footer_terms' },
  { path: '/privacy', key: 'legal.footer_privacy' },
  { path: '/docs/whitepaper', key: 'legal.footer_whitepaper' },
  { path: '/docs', key: 'legal.footer_docs' },
] as const;

export async function fetchDocsManifest(): Promise<DocsManifest> {
  const response = await fetch('/docs/index.json');
  if (!response.ok) throw new Error('Failed to load docs index');
  return response.json();
}

export function pickLocaleValue(map: Record<string, string>, fallbackOrder: readonly string[]): string | undefined {
  for (const key of fallbackOrder) {
    if (map[key]) return map[key];
  }
  const first = Object.keys(map)[0];
  return first ? map[first] : undefined;
}

export function preferredTitle(doc: DocEntry, locale: string): string {
  return pickLocaleValue(doc.title, [locale, ...LOCALES, '']) || doc.slug;
}

export function preferredFile(doc: DocEntry, locale: string): string {
  return pickLocaleValue(doc.files, [locale, 'en', 'ja', '']) || '';
}
