export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'flaxia_theme';
const LIGHT_COLOR = '#ffffff';
const DARK_COLOR = '#09090b';

let mediaListenerAttached = false;

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {}
  return 'system';
}

export function getResolvedTheme(): 'light' | 'dark' {
  const theme = getTheme();
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark() ? 'dark' : 'light';
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function updateThemeColor(resolved: 'light' | 'dark'): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? DARK_COLOR : LIGHT_COLOR);
}

/**
 * Swap the surface tokens, then drop the class that keeps the swap
 * animated. Without this the theme change is an instant flash of every
 * border and panel on the page at once (motion.css: html.is-theme-switching).
 */
function transitionTheme(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  root.classList.add('is-theme-switching');
  window.setTimeout(() => root.classList.remove('is-theme-switching'), 220);
}

export function applyTheme(): void {
  const resolved = getResolvedTheme();
  transitionTheme(resolved);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  updateThemeColor(resolved);
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
  applyTheme();
}

export function initTheme(): void {
  applyTheme();

  if (!mediaListenerAttached && typeof window !== 'undefined' && window.matchMedia) {
    mediaListenerAttached = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const stored = getTheme();
      if (stored === 'system') applyTheme();
    });
  }
}
