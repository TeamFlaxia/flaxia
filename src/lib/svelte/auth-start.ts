// Web/native sign-in entrypoint, replacing the `login`/`register` branches of
// the deleted legacy main.ts. Authentication UI lives on auth.flaxia.app; the
// web flow goes through /api/auth/start (which sets the PKCE cookie and 302s),
// while native apps open the system browser directly.
import { beginNativeAuthRedirect } from '../auth-redirect.ts';
import { getLocale, t } from '../i18n.ts';
import { isNativeApp } from '../native-api.ts';
import { getResolvedTheme } from '../theme.ts';
import { showToast } from '../toast.ts';

export async function startAuthRedirect(mode: 'login' | 'register'): Promise<void> {
  const url = new URL(window.location.href);
  // Never return to /login?error=…: that would loop through auth forever.
  const returnTo = url.pathname === '/login' || url.pathname === '/register' ? '/home' : `${url.pathname}${url.search}`;

  if (await beginNativeAuthRedirect(returnTo, mode)) return;
  if (isNativeApp()) {
    // The in-app WebView cannot reach /api/auth/start on its own origin.
    console.warn('[auth] native sign-in browser could not be opened');
    showToast(t('auth.external_failed'), true);
    return;
  }

  const query = new URLSearchParams({
    return_to: returnTo,
    lang: getLocale(),
    theme: getResolvedTheme(),
  });
  if (mode === 'register') query.set('mode', 'register');
  window.location.assign(`/api/auth/start?${query.toString()}`);
}
