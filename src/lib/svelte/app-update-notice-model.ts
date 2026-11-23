// Pure link choice for the app update notice: Windows prefers the MSI asset,
// everything else opens the tagged release page.
import type { AppUpdatePlatform } from '../app-update.ts';

export interface AppUpdateNoticeTarget {
  releaseUrl: string;
  windowsMsiUrl?: string | null;
}

export function appUpdateNoticeHref(update: AppUpdateNoticeTarget, platform: AppUpdatePlatform | null): string {
  return platform === 'windows' && update.windowsMsiUrl ? update.windowsMsiUrl : update.releaseUrl;
}
