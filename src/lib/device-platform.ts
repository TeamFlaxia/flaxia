export type DevicePlatform = 'android' | 'windows' | 'linux' | 'other';

export interface DevicePlatformParts {
  userAgent?: string;
  platform?: string;
  userAgentDataPlatform?: string;
}

/**
 * Classify the current device from user-agent signals.
 *
 * Android is checked before Linux because Android user agents include
 * "Linux". ChromeOS is excluded from Linux because Play Store/desktop
 * packages do not target it.
 */
export function classifyDevicePlatform(parts: DevicePlatformParts): DevicePlatform {
  const source = `${parts.userAgentDataPlatform ?? ''} ${parts.platform ?? ''} ${parts.userAgent ?? ''}`.toLowerCase();

  if (source.includes('android')) return 'android';
  if (source.includes('cros')) return 'other';
  if (/\b(windows|win32|win64|winnt)\b/.test(source)) return 'windows';
  if (/\b(linux|x11)\b/.test(source)) return 'linux';
  return 'other';
}

/** Detect the platform of the browser running this code. */
export function detectDevicePlatform(): DevicePlatform {
  if (typeof navigator === 'undefined') return 'other';

  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return classifyDevicePlatform({
    userAgent: nav.userAgent,
    platform: nav.platform,
    userAgentDataPlatform: nav.userAgentData?.platform,
  });
}
