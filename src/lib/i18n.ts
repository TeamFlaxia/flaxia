type Locale = string;
type Strings = Record<string, string>;

let currentLocale: Locale = 'ja';
let strings: Strings = {};
let fallbackStrings: Strings = {};
let loadPromise: Promise<void> | null = null;

/**
 * Request-scoped strings for SSR. `hooks.server.ts` installs a resolver backed
 * by AsyncLocalStorage so concurrent requests with different locales cannot
 * overwrite each other's translations.
 */
export interface LocaleData {
  locale: Locale;
  strings: Strings;
  fallback: Strings;
}
let localeResolver: (() => LocaleData | null) | null = null;

export function setLocaleResolver(resolver: (() => LocaleData | null) | null): void {
  localeResolver = resolver;
}

const STORAGE_KEY = 'flaxia_locale';

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    return navigator.language.startsWith('ja') ? 'ja' : 'en';
  } catch {
    return 'en';
  }
}

async function loadLocaleFile(locale: Locale): Promise<Strings> {
  const response = await fetch(`/locales/${locale}.json`);
  if (!response.ok) throw new Error(`Failed to load locale: ${locale}`);
  return response.json();
}

export async function setLocale(locale: Locale): Promise<void> {
  const [data, fallback] = await Promise.all([
    loadLocaleFile(locale).catch(() => ({})),
    loadLocaleFile('en').catch(() => ({})),
  ]);
  strings = data;
  fallbackStrings = fallback;
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
    // Mirror the choice to a cookie so SSR can render the same locale.
    document.cookie = `${STORAGE_KEY}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    /* ignore */
  }
  document.documentElement.lang = locale;
  window.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
}

export function t(key: string, params?: Record<string, string | number>): string {
  const scoped = localeResolver?.() ?? null;
  let s = scoped ? scoped.strings[key] : strings[key];
  if (s === undefined) s = scoped ? scoped.fallback[key] : fallbackStrings[key];
  if (s === undefined) s = key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

export function getLocale(): Locale {
  return currentLocale;
}

export async function initI18n(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const initial = getInitialLocale();
      await setLocale(initial);
    })();
  }
  return loadPromise;
}
