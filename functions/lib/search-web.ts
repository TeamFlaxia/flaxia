export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published_at?: string;
}

export interface WebSearchOptions {
  limit: number;
  language?: string;
  sites?: string[];
}

interface ProviderResult {
  source: string;
  items: WebSearchResult[];
}

const PROVIDER_TIMEOUT_MS = 2500;
const SNIPPET_LIMIT = 260;

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_LIMIT);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Web search provider returned ${response.status}`);
  return response.json();
}

function providerLimit(limit: number): number {
  return Math.max(2, Math.min(5, limit));
}

function wikipediaUrl(language: string, title: string): string {
  return `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

function wikipediaLanguage(query: string, language?: string): string {
  if (language?.toLowerCase().startsWith('ja')) return 'ja';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(query)) return 'ja';
  return 'en';
}

async function searchWikipedia(query: string, options: WebSearchOptions): Promise<ProviderResult> {
  const language = wikipediaLanguage(query, options.language);
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(providerLimit(options.limit)),
    format: 'json',
    origin: '*',
  });
  const data = asRecord(await fetchJson(`https://${language}.wikipedia.org/w/api.php?${params.toString()}`));
  const pages = asArray(asRecord(data.query).search);

  return {
    source: 'Wikipedia',
    items: pages.map((page) => {
      const item = asRecord(page);
      const title = asString(item.title);
      return {
        title,
        url: wikipediaUrl(language, title),
        snippet: stripMarkup(asString(item.snippet)),
        source: 'Wikipedia',
      };
    }),
  };
}

async function searchHackerNews(query: string, options: WebSearchOptions): Promise<ProviderResult> {
  const params = new URLSearchParams({
    query,
    tags: 'story',
    hitsPerPage: String(providerLimit(options.limit)),
  });
  const data = asRecord(await fetchJson(`https://hn.algolia.com/api/v1/search?${params.toString()}`));
  const hits = asArray(data.hits);

  return {
    source: 'Hacker News',
    items: hits.map((hit) => {
      const item = asRecord(hit);
      const title = asString(item.title);
      return {
        title,
        url: asString(item.url) || `https://news.ycombinator.com/item?id=${asString(item.objectID)}`,
        snippet: stripMarkup(asString(item.story_text) || title),
        source: 'Hacker News',
        published_at: asString(item.created_at) || undefined,
      };
    }),
  };
}

async function searchStackExchange(query: string, options: WebSearchOptions): Promise<ProviderResult> {
  const params = new URLSearchParams({
    order: 'desc',
    sort: 'relevance',
    q: query,
    site: 'stackoverflow',
    pagesize: String(providerLimit(options.limit)),
    filter: 'default',
  });
  const data = asRecord(await fetchJson(`https://api.stackexchange.com/2.3/search/advanced?${params.toString()}`));
  const items = asArray(data.items);

  return {
    source: 'Stack Overflow',
    items: items.map((entry) => {
      const item = asRecord(entry);
      const title = stripMarkup(asString(item.title));
      return {
        title,
        url: asString(item.link),
        snippet: stripMarkup(asString(item.body_markdown) || title),
        source: 'Stack Overflow',
      };
    }),
  };
}

async function searchGitHub(query: string, options: WebSearchOptions): Promise<ProviderResult> {
  const params = new URLSearchParams({
    q: query,
    per_page: String(providerLimit(options.limit)),
    sort: 'stars',
    order: 'desc',
  });
  const data = asRecord(
    await fetchJson(`https://api.github.com/search/repositories?${params.toString()}`, {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Flaxia-Search',
    }),
  );
  const items = asArray(data.items);

  return {
    source: 'GitHub',
    items: items.map((entry) => {
      const item = asRecord(entry);
      const stars = asNumber(item.stargazers_count);
      const description = asString(item.description);
      return {
        title: asString(item.full_name),
        url: asString(item.html_url),
        snippet: stars > 0 ? `${description} · ${stars.toLocaleString()} stars` : description,
        source: 'GitHub',
        published_at: asString(item.updated_at) || undefined,
      };
    }),
  };
}

async function searchNpm(query: string, options: WebSearchOptions): Promise<ProviderResult> {
  const params = new URLSearchParams({
    text: query,
    size: String(providerLimit(options.limit)),
  });
  const data = asRecord(await fetchJson(`https://registry.npmjs.org/-/v1/search?${params.toString()}`));
  const objects = asArray(data.objects);

  return {
    source: 'npm',
    items: objects.map((entry) => {
      const item = asRecord(entry);
      const pkg = asRecord(item.package);
      const links = asRecord(pkg.links);
      const title = asString(pkg.name);
      const version = asString(pkg.version);
      return {
        title: version ? `${title}@${version}` : title,
        url: asString(links.npm) || `https://www.npmjs.com/package/${encodeURIComponent(title)}`,
        snippet: stripMarkup(asString(pkg.description)),
        source: 'npm',
      };
    }),
  };
}

function matchesSite(result: WebSearchResult, sites: string[] | undefined): boolean {
  if (!sites || sites.length === 0) return true;
  try {
    const hostname = new URL(result.url).hostname.toLowerCase();
    return sites.some((site) => hostname === site || hostname.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export async function searchWeb(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const providers = await Promise.allSettled([
    searchWikipedia(trimmed, options),
    searchHackerNews(trimmed, options),
    searchStackExchange(trimmed, options),
    searchGitHub(trimmed, options),
    searchNpm(trimmed, options),
  ]);

  const lists = providers
    .filter((result): result is PromiseFulfilledResult<ProviderResult> => result.status === 'fulfilled')
    .map((result) => result.value.items.filter((item) => item.title && item.url));

  const merged: WebSearchResult[] = [];
  const seen = new Set<string>();
  const maxItems = Math.min(options.limit, 20);

  for (let index = 0; merged.length < maxItems; index += 1) {
    let added = false;
    for (const list of lists) {
      const item = list[index];
      if (!item) continue;
      added = true;
      if (!matchesSite(item, options.sites)) continue;
      const key = dedupeKey(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= maxItems) break;
    }
    if (!added) break;
  }

  return merged;
}
