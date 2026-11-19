/**
 * Reactive bridge between the legacy i18n module and Svelte components.
 *
 * The legacy `setLocale()` already dispatches a `localechange` event. This
 * store mirrors that event so Svelte components can subscribe to the locale
 * without changing any of the 1,296 existing `t()` calls.
 */
import { type Readable, writable } from 'svelte/store';
import { getLocale, t } from './i18n.ts';

type Params = Record<string, string | number>;
type Translate = (key: string, params?: Params) => string;

const current = writable<string>(getLocale());

if (typeof window !== 'undefined') {
  window.addEventListener('localechange', (event) => {
    const locale = (event as CustomEvent<{ locale: string }>).detail?.locale;
    if (locale) current.set(locale);
  });
}

/** Current locale, updated whenever the legacy app switches language. */
export const locale: Readable<string> = { subscribe: current.subscribe };

/**
 * A store whose value is the legacy `t()` function. Subscribers re-run on
 * locale changes, so Svelte markup can call `$translate('key')`.
 */
export const translate: Readable<Translate> = {
  subscribe(run) {
    return current.subscribe(() => run(t));
  },
};
