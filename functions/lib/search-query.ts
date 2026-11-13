export type SearchTab = 'all' | 'web' | 'posts' | 'users' | 'games';

export interface ParsedSearchQuery {
  raw: string;
  terms: string[];
  phrases: string[];
  hashtags: string[];
  from: string[];
  sites: string[];
}

const FILTER_PATTERN = /^(from|site):(.+)$/i;

function isShortTerm(term: string): boolean {
  return Array.from(term).length < 3;
}

function normalizeTerm(value: string): string {
  return value.normalize('NFKC').trim();
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const normalized = normalizeTerm(raw).slice(0, 200);
  const terms: string[] = [];
  const phrases: string[] = [];
  const hashtags: string[] = [];
  const from: string[] = [];
  const sites: string[] = [];

  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null = pattern.exec(normalized);
  while (match !== null) {
    const phrase = match[1] === undefined ? '' : normalizeTerm(match[1]);
    const token = match[2] === undefined ? '' : normalizeTerm(match[2]);

    if (phrase) {
      phrases.push(phrase);
    } else if (token) {
      const filterMatch = FILTER_PATTERN.exec(token);
      if (filterMatch) {
        const value = normalizeTerm(filterMatch[2]);
        if (value) {
          if (filterMatch[1].toLowerCase() === 'from') from.push(value.replace(/^@/, ''));
          else sites.push(value.toLowerCase());
        }
      } else if (token.startsWith('#')) {
        const tag = normalizeTerm(token.slice(1));
        if (tag) hashtags.push(tag);
      } else if (token.startsWith('@')) {
        const username = normalizeTerm(token.slice(1));
        if (username) from.push(username);
      } else {
        terms.push(token);
      }
    }
    match = pattern.exec(normalized);
  }

  return {
    raw: normalized,
    terms,
    phrases,
    hashtags,
    from,
    sites,
  };
}

export function searchTextTerms(parsed: ParsedSearchQuery): string[] {
  return [...parsed.phrases, ...parsed.terms];
}

export function buildFtsMatch(parsed: ParsedSearchQuery): string | null {
  const terms = searchTextTerms(parsed);
  if (terms.length === 0 || terms.some(isShortTerm)) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

export function buildLikePattern(term: string): string {
  return `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export function parseSearchTab(value: string | undefined): SearchTab {
  switch (value) {
    case 'web':
    case 'posts':
    case 'users':
    case 'games':
      return value;
    default:
      return 'all';
  }
}
