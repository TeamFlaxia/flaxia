// Web Push registration via Service Worker (split out of main.ts).
//
// Browser-only flow: fetch the VAPID public key, subscribe with PushManager,
// and report the subscription to the server. Skipped on Tauri/Capacitor
// (native push there) and on browsers without Service Worker support.
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function registerPushToken(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return; // not supported (Tauri or old browser)
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Get VAPID public key from server
    const keyRes = await fetch('/api/push/vapid-key');
    if (!keyRes.ok) return;
    const { publicKey } = (await keyRes.json()) as { publicKey: string };

    // Subscribe
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(sub.toJSON()),
    });
    console.log('Web Push subscription registered');
  } catch (err) {
    console.log('Web Push registration not available:', err);
  }
}

export async function initializeWebPush(isNativePlatform: boolean): Promise<void> {
  if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
    return; // Tauri desktop/mobile — no Service Worker push needed
  }
  if (isNativePlatform) {
    return; // Capacitor mobile — no Service Worker push needed
  }
  await registerPushToken();
}
