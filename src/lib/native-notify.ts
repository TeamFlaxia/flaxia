// Native notification platforms: Tauri (desktop/mobile) + Capacitor (mobile).
// Split out of main.ts.
//
// Behavior is preserved exactly:
// - WebSocket push messages notify via Tauri only (Capacitor gets its OS
//   notifications from FCM, so notifying there too would double-notify).
// - FCM foreground messages notify via Capacitor local notifications only.
// - Badge updates prefer Capacitor, falling back to Tauri; the Rust tray
//   counter is invoked whenever available. Mark-all-read clears both badges.
let tauriNotify: ((title: string, body: string) => Promise<void>) | null = null;
let tauriBadge: ((count: number) => Promise<void>) | null = null;
let tauriSetNotificationCount: ((count: number) => Promise<void>) | null = null;
let capacitorNotify: ((title: string, body: string) => Promise<void>) | null = null;
let capacitorBadge: ((count: number) => Promise<void>) | null = null;

const isCapacitorNativePlatform = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.Capacitor !== 'undefined' &&
  typeof window.Capacitor.isNativePlatform === 'function' &&
  window.Capacitor.isNativePlatform();

async function initTauriNotifications(): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );

    try {
      const granted = await isPermissionGranted();
      if (!granted) {
        await requestPermission();
      }
    } catch {
      // permission API not supported on this platform — proceed anyway
    }

    tauriNotify = async (title: string, body: string) => {
      try {
        await sendNotification({ title, body: body || title });
      } catch (err) {
        console.error('[notif] sendNotification failed:', err);
      }
    };
  } catch {
    console.log('[notif] Tauri notification plugin not available — OS notifications disabled');
  }
}

/** Dock/taskbar badge + tray icon badge — independent of the notification plugin. */
async function initTauriBadge(): Promise<void> {
  const isTauriEnv = typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__);

  if (!isTauriEnv) {
    console.log('[badge] Not in Tauri environment — skipping badge init');
    return;
  }

  // Dock/taskbar badge count (macOS, Windows, some Linux DEs)
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    tauriBadge = async (count: number) => {
      try {
        await getCurrentWindow().setBadgeCount(count);
      } catch (err) {
        console.log('[badge] setBadgeCount failed:', err);
      }
    };
  } catch {
    console.log('[badge] @tauri-apps/api/window not available');
  }

  // Desktop tray icon: invoke Rust set_notification_count
  if (!/Android/i.test(navigator.userAgent)) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      tauriSetNotificationCount = async (count: number) => {
        try {
          await invoke('set_notification_count', { count });
        } catch (err) {
          console.log('[badge] invoke error:', err);
        }
      };
    } catch {
      console.log('[badge] @tauri-apps/api/core not available');
    }
  }
}

async function initCapacitorNotifications(): Promise<void> {
  try {
    if (!isCapacitorNativePlatform()) return;

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const { Badge } = await import('@capawesome/capacitor-badge');

    await LocalNotifications.requestPermissions();

    try {
      await LocalNotifications.createChannel({
        id: 'flaxia_notifications',
        name: 'Flaxia Notifications',
        importance: 5,
        sound: 'default',
        visibility: 1,
      });
    } catch {
      // channel may already exist
    }

    let notifId = 0;
    capacitorNotify = async (title: string, body: string) => {
      try {
        notifId = (notifId + 1) % 2147483647;
        await LocalNotifications.schedule({
          notifications: [
            {
              title,
              body,
              id: notifId,
              channelId: 'flaxia_notifications',
              smallIcon: 'ic_stat_flaxia',
            },
          ],
        });
      } catch (err) {
        console.error('[notif] Capacitor sendNotification failed:', err);
      }
    };

    capacitorBadge = async (count: number) => {
      try {
        await Badge.set({ count });
      } catch {
        // badge not supported
      }
    };
  } catch {
    // Not running in Capacitor
  }
}

/** Initialize all native notification/badge channels (fire-and-forget safe). */
export async function initNativeNotify(): Promise<void> {
  await Promise.all([initTauriNotifications(), initTauriBadge(), initCapacitorNotifications()]);
}

/** Capacitor FCM registration: report the device token to the server. */
export async function initNativePushRegistration(): Promise<void> {
  if (!isCapacitorNativePlatform()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.requestPermissions();
    await PushNotifications.register();

    await PushNotifications.addListener('registration', (token) => {
      fetch('/api/push/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type: 'fcm', endpoint: token.value }),
      }).catch((err) => console.error('[push] FCM register failed:', err));
    });

    await PushNotifications.addListener('registrationError', (err) => {
      console.error('[push] FCM registration error:', err);
    });

    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      if (notification.title && typeof capacitorNotify === 'function') {
        capacitorNotify(notification.title, notification.body || '');
      }
    });

    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const clickUrl = action.notification?.data?.click_url;
      if (clickUrl) {
        window.location.href = clickUrl;
      }
    });
  } catch {
    console.log('[push] @capacitor/push-notifications not available');
  }
}

/** WebSocket push path: Tauri only (Capacitor is served by FCM). */
export function notifyViaTauri(title: string, body: string): void {
  if (typeof tauriNotify === 'function') {
    tauriNotify(title, body);
  }
}

/** Badge update: Capacitor preferred, Tauri fallback, plus Rust tray counter. */
export function setNativeBadge(count: number): void {
  if (capacitorBadge) {
    capacitorBadge(count);
  } else if (tauriBadge) {
    tauriBadge(count);
  }

  if (tauriSetNotificationCount) {
    tauriSetNotificationCount(count).catch((err) => {
      console.log('[badge] set_notification_count failed:', err);
    });
  }
}

/** Mark-all-read path: clear both badges wherever available. */
export async function clearNativeBadge(): Promise<void> {
  if (capacitorBadge) {
    await capacitorBadge(0);
  }
  if (tauriBadge) {
    await tauriBadge(0);
  }
}
