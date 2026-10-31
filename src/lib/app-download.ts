import type { DevicePlatform } from './device-platform.js';

export type AppPlatform = 'android' | 'windows' | 'linux';

export const APP_PLATFORMS: readonly AppPlatform[] = ['android', 'windows', 'linux'];

export const APP_RELEASES_URL = 'https://github.com/TeamFlaxia/flaxia/releases/latest';
export const APP_ANDROID_APK_URL = `${APP_RELEASES_URL}/download/app-release.apk`;
export const APP_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=app.flaxia.app';

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
