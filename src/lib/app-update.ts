import { isTauriNativePlatform } from './native-api.ts';

export const APP_UPDATE_RELEASES_API = 'https://api.github.com/repos/TeamFlaxia/flaxia/releases/latest';
export const APP_UPDATE_RELEASES_URL = 'https://github.com/TeamFlaxia/flaxia/releases/latest';

const DISMISSED_KEY = 'flaxia:app-update:dismissed';
const CACHE_KEY = 'flaxia:app-update:latest-release';
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface AppReleaseInfo {
  tagName: string;
  releaseUrl: string;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  releaseUrl: string;
}

/** Normalize "v1.2.3" to "1.2.3"; null for non-semver tags. */
export function normalizeAppVersion(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function versionParts(version: string): [number, number, number] | null {
  const normalized = normalizeAppVersion(version);
  if (!normalized) return null;
  const [major, minor, patch] = normalized.split('.').map(Number);
  return [major, minor, patch];
}

export function isNewerAppVersion(currentVersion: string, latestVersion: string): boolean {
  const current = versionParts(currentVersion);
  const latest = versionParts(latestVersion);
  if (!current || !latest) return false;

  for (let i = 0; i < current.length; i++) {
    if (latest[i] > current[i]) return true;
    if (latest[i] < current[i]) return false;
  }
  return false;
}

/** Update prompts only apply to Tauri desktop builds for Windows and Linux. */
export function supportsAppUpdatePrompt(options: { userAgent?: string; isTauri?: boolean } = {}): boolean {
  const isTauri = options.isTauri ?? isTauriNativePlatform();
  if (!isTauri) return false;

  const userAgent = options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) return false;
  return ua.includes('windows') || ua.includes('linux');
}

function isTrustedReleaseUrl(url: string): boolean {
  return (
    url === APP_UPDATE_RELEASES_URL || /^https:\/\/github\.com\/TeamFlaxia\/flaxia\/releases\/tag\/[^/?#]+$/.test(url)
  );
}

export function parseLatestAppRelease(data: unknown): AppReleaseInfo | null {
  if (!data || typeof data !== 'object') return null;

  const release = data as {
    tag_name?: unknown;
    html_url?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  };
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== 'string' || !normalizeAppVersion(release.tag_name)) return null;

  const releaseUrl =
    typeof release.html_url === 'string' && isTrustedReleaseUrl(release.html_url)
      ? release.html_url
      : APP_UPDATE_RELEASES_URL;

  return { tagName: release.tag_name.trim(), releaseUrl };
}

function readCachedRelease(now: number): AppReleaseInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const cached = JSON.parse(raw) as { fetchedAt?: unknown; tagName?: unknown; releaseUrl?: unknown };
    if (
      typeof cached.fetchedAt !== 'number' ||
      cached.fetchedAt > now ||
      now - cached.fetchedAt > CACHE_TTL_MS ||
      typeof cached.tagName !== 'string' ||
      !normalizeAppVersion(cached.tagName) ||
      typeof cached.releaseUrl !== 'string' ||
      !isTrustedReleaseUrl(cached.releaseUrl)
    ) {
      return null;
    }

    return { tagName: cached.tagName, releaseUrl: cached.releaseUrl };
  } catch {
    return null;
  }
}

function writeCachedRelease(release: AppReleaseInfo, now: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...release, fetchedAt: now }));
  } catch {
    // Private mode/storage quota must not break the app.
  }
}

export async function fetchLatestAppRelease(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<AppReleaseInfo | null> {
  const cached = readCachedRelease(now);
  if (cached) return cached;

  try {
    const response = await fetchImpl(APP_UPDATE_RELEASES_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;

    const release = parseLatestAppRelease(await response.json());
    if (!release) return null;

    writeCachedRelease(release, now);
    return release;
  } catch {
    return null;
  }
}

export async function getCurrentAppVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return normalizeAppVersion(await getVersion());
  } catch {
    return null;
  }
}

export function dismissAppUpdate(tagName: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, tagName);
  } catch {
    // Dismissal is best-effort.
  }
}

export function isAppUpdateDismissed(tagName: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === tagName;
  } catch {
    return false;
  }
}

export async function checkForAppUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppUpdateInfo | null> {
  const current = normalizeAppVersion(currentVersion);
  if (!current) return null;

  const release = await fetchLatestAppRelease(fetchImpl);
  if (!release) return null;

  const latest = normalizeAppVersion(release.tagName);
  if (!latest || !isNewerAppVersion(current, latest) || isAppUpdateDismissed(release.tagName)) {
    return null;
  }

  return {
    currentVersion: current,
    latestVersion: latest,
    latestTag: release.tagName,
    releaseUrl: release.releaseUrl,
  };
}

/** Check once after startup and show a dismissible update card when needed. */
export async function maybePromptAppUpdate(): Promise<void> {
  if (!import.meta.env.PROD || !supportsAppUpdatePrompt()) return;

  const current = await getCurrentAppVersion();
  if (!current) return;

  const update = await checkForAppUpdate(current);
  if (!update) return;

  const { showAppUpdateNotice } = await import('../components/AppUpdateNotice.js');
  showAppUpdateNotice(update, () => dismissAppUpdate(update.latestTag));
}
