import type { DevicePlatform } from './device-platform.js';

export type AppPlatform = 'android' | 'windows' | 'linux';

export const APP_PLATFORMS: readonly AppPlatform[] = ['android', 'windows', 'linux'];

export const APP_RELEASES_API = 'https://api.github.com/repos/TeamFlaxia/flaxia/releases/latest';
export const APP_RELEASES_URL = 'https://github.com/TeamFlaxia/flaxia/releases/latest';
export const APP_ANDROID_APK_URL = `${APP_RELEASES_URL}/download/app-release.apk`;
export const APP_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=app.flaxia.app';

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

function isTrustedReleaseAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && url.pathname.startsWith('/TeamFlaxia/flaxia/releases/download/');
  } catch {
    return false;
  }
}

export function isTrustedWindowsMsiUrl(value: string): boolean {
  if (!isTrustedReleaseAssetUrl(value)) return false;
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.msi');
  } catch {
    return false;
  }
}

export function findWindowsMsiUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const assets = (data as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return null;

  let fallback: string | null = null;
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const { name, browser_download_url: url } = asset as ReleaseAsset;
    if (typeof name !== 'string' || !name.toLowerCase().endsWith('.msi')) continue;
    if (typeof url !== 'string' || !isTrustedWindowsMsiUrl(url)) continue;
    if (/x64|x86_64/i.test(name)) return url;
    fallback ??= url;
  }
  return fallback;
}

export async function resolveWindowsMsiUrl(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(APP_RELEASES_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    return findWindowsMsiUrl(await response.json());
  } catch {
    return null;
  }
}

/** The installable platform matching this device, if Flaxia ships one. */
export function recommendedAppPlatform(device: DevicePlatform): AppPlatform | null {
  return device === 'android' || device === 'windows' || device === 'linux' ? device : null;
}

/** Platform cards with the current device's platform first. */
export function orderAppPlatforms(device: DevicePlatform): AppPlatform[] {
  const recommended = recommendedAppPlatform(device);
  if (!recommended) return [...APP_PLATFORMS];
  return [recommended, ...APP_PLATFORMS.filter((platform) => platform !== recommended)];
}
