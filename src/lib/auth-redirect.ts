// Native sign-in uses the system browser so the Auth session cookie belongs to
// auth.flaxia.app, then returns through the app's custom URL scheme. The PKCE
// verifier never leaves this device.
import { isCapacitorNativePlatform, isNativeApp, isTauriNativePlatform } from './native-api.ts';

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

function readPending(): PendingAuth | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Partial<PendingAuth> | null;
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

async function openExternal(url: string): Promise<void> {
  if (isCapacitorNativePlatform()) {
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
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const target = new URL('/login', AUTH_ORIGIN);
  target.searchParams.set('code_challenge', await challengeFor(pending.verifier));
  target.searchParams.set('state', pending.state);
  target.searchParams.set('return_uri', RETURN_URI);
  if (mode === 'register') target.searchParams.set('mode', 'register');
  try {
    await openExternal(target.toString());
    return true;
  } catch {
    sessionStorage.removeItem(PENDING_KEY);
    return false;
  }
}

async function redeemCode(callbackUrl: string): Promise<void> {
  const pending = readPending();
  if (!pending) return;
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return;
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== pending.state) return;
  // Single-use: drop the verifier before any network activity.
  sessionStorage.removeItem(PENDING_KEY);
  const response = await fetch('/api/auth/flaxia/exchange', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, verifier: pending.verifier }),
  });
  if (!response.ok) {
    window.location.replace('/home');
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
