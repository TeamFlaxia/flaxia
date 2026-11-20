export type LegalPageType = 'terms' | 'privacy' | 'child-safety' | 'about';

interface LegalPageConfig {
  fileName: string;
  titleKey: string;
  footerKey: string;
  path: string;
}

export const LEGAL_PAGES: Record<LegalPageType, LegalPageConfig> = {
  terms: { fileName: 'terms', titleKey: 'legal.terms_title', footerKey: 'legal.footer_terms', path: '/terms' },
  privacy: {
    fileName: 'privacy',
    titleKey: 'legal.privacy_title',
    footerKey: 'legal.footer_privacy',
    path: '/privacy',
  },
  'child-safety': {
    fileName: 'child-safety',
    titleKey: 'legal.child_safety_title',
    footerKey: 'legal.footer_child_safety',
    path: '/child-safety',
  },
  about: { fileName: 'about', titleKey: 'legal.about_title', footerKey: 'legal.footer_about', path: '/about' },
};

export const ALL_PAGES: LegalPageConfig[] = Object.values(LEGAL_PAGES);

export async function fetchLegalMarkdown(fileName: string, locale: string): Promise<string> {
  const response = await fetch(`/legal/${fileName}.${locale}.md`);
  if (!response.ok) throw new Error('Failed to load');
  return response.text();
}
