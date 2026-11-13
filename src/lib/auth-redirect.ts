// Native sign-in uses the system browser so the Auth session cookie belongs to
// auth.flaxia.app, then returns through the app's custom URL scheme. The PKCE
// verifier never leaves this device.
import { getLocale } from './i18n.ts';
import { isCapacitorNativePlatform, isNativeApp, isTauriNativePlatform } from './native-api.ts';
import { getResolvedTheme } from './theme.ts';

const AUTH_ORIGIN = 'https://auth.flaxia.app';
const RETURN_URI = 'flaxia://auth/callback';
const PENDING_KEY = 'flaxia.auth.pending';

interface PendingAuth {
  verifier: string;
  state: string;
  returnTo: string;
}

const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const base64url = (bytes: Uint8Array): string =>
  encode(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function safeReturnPath(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/home';
  return raw;
}

function readStore(store: Storage): string | null {
  try {
    return store.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

function storageWrite(value: string): void {
  try {
    localStorage.setItem(PENDING_KEY, value);
  } catch {
    // Fall through to sessionStorage below (best-effort outside the WebView).
  }
  try {
    sessionStorage.setItem(PENDING_KEY, value);
  } catch {
    // Both stores unavailable: the flow cannot complete, but do not throw.
  }
}

function storageClear(): void {
  for (const store of [localStorage, sessionStorage]) {
    try {
      store.removeItem(PENDING_KEY);
    } catch {
      // best-effort
    }
  }
}

function parsePending(raw: string | null): PendingAuth | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingAuth> | null;
    if (
      !value ||
      typeof value.verifier !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.verifier) ||
      typeof value.state !== 'string' ||
      typeof value.returnTo !== 'string'
    )
      return null;
    return { verifier: value.verifier, state: value.state, returnTo: value.returnTo };
  } catch {
    return null;
  }
}

function readPending(): PendingAuth | null {
  // localStorage survives the OS evicting the backgrounded WebView while the
  // user is in the system browser; sessionStorage is kept for upgrades from
  // older builds. Validate each value so a corrupt legacy entry cannot hide a
  // valid one.
  return parsePending(readStore(localStorage)) ?? parsePending(readStore(sessionStorage));
}

async function openExternal(url: string): Promise<void> {
  if (isCapacitorNativePlatform()) {
    // `@capacitor/browser` opens an in-app browser (Custom Tab /
    // SFSafariViewController), which can refuse the flaxia:// return. Prefer
    // the system browser through AppLauncher so the deep link is routed by
    // the OS straight back into the app; fall back to Browser.open.
    try {
      const { AppLauncher } = await import('@capacitor/app-launcher');
      const result = await AppLauncher.openUrl({ url });
      if (result.completed) return;
    } catch {
      // fall through to Browser.open
    }
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
    return;
  }
  if (isTauriNativePlatform()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.location.assign(url);
}

/**
 * Start a native sign-in. Returns false when the caller should fall back to the
 * web redirect (or when the platform browser could not be opened).
 */
export async function beginNativeAuthRedirect(
  returnTo: string,
  mode: 'login' | 'register' = 'login',
): Promise<boolean> {
  if (!isNativeApp()) return false;
  const pending: PendingAuth = {
    verifier: randomToken(),
    state: randomToken(),
    returnTo: safeReturnPath(returnTo),
  };
  storageWrite(JSON.stringify(pending));
  const target = new URL('/login', AUTH_ORIGIN);
  target.searchParams.set('code_challenge', await challengeFor(pending.verifier));
  target.searchParams.set('state', pending.state);
  target.searchParams.set('return_uri', RETURN_URI);
  target.searchParams.set('lang', getLocale());
  target.searchParams.set('theme', getResolvedTheme());
  if (mode === 'register') target.searchParams.set('mode', 'register');
  try {
    await openExternal(target.toString());
    return true;
  } catch (error) {
    console.warn('[auth] could not open the sign-in browser', error);
    storageClear();
    return false;
  }
}

async function redeemCode(callbackUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    console.warn('[auth] deep-link callback ignored: unparsable URL', callbackUrl);
    return;
  }
  // Only the auth return URI may consume or clear a pending PKCE verifier.
  // Any other flaxia:// link (a future feature, or a malicious page opening
  // the custom scheme) must not be able to cancel an in-flight sign-in.
  if (url.protocol !== 'flaxia:' || url.host !== 'auth' || url.pathname !== '/callback') {
    console.warn('[auth] deep-link callback ignored: not the auth return URI');
    return;
  }
  const pending = readPending();
  if (!pending) {
    console.warn('[auth] deep-link callback ignored: no pending sign-in (verifier lost?)');
    return;
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== pending.state) {
    console.warn('[auth] deep-link callback ignored: missing code or state mismatch');
    storageClear();
    window.location.replace('/login?error=state_mismatch');
    return;
  }
  // The verifier stays until the exchange answers, so a transient network
  // failure cannot strand an otherwise-valid one-time code.
  let response: Response;
  try {
    response = await fetch('/api/auth/flaxia/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier: pending.verifier }),
    });
  } catch (error) {
    console.warn('[auth] code exchange request failed', error);
    storageClear();
    window.location.replace('/login?error=network');
    return;
  }
  storageClear();
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.warn(`[auth] code exchange rejected with ${response.status}: ${body.slice(0, 200)}`);
    window.location.replace(`/login?error=exchange_${response.status}`);
    return;
  }
  window.location.replace(safeReturnPath(pending.returnTo));
}

/** Wire the native URL handlers. Safe to call on web (it does nothing). */
export function initNativeAuthCallback(): void {
  if (!isNativeApp()) return;
  if (isCapacitorNativePlatform()) {
    void (async () => {
      const { App } = await import('@capacitor/app');
      await App.addListener('appUrlOpen', ({ url }) => void redeemCode(url));
      const launch = await App.getLaunchUrl();
      if (launch?.url) void redeemCode(launch.url);
    })();
    return;
  }
  if (isTauriNativePlatform()) {
    void (async () => {
      const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
      await onOpenUrl((urls) => {
        for (const url of urls) void redeemCode(url);
      });
      const current = await getCurrent();
      for (const url of current ?? []) void redeemCode(url);
    })();
  }
}
