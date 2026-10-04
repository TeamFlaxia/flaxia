// Web Push registration helpers (split out of main.ts).
//
// Pure base64url → bytes conversion for the VAPID public key. The
// Service-Worker registration flow itself stays in main.ts because it needs
// the bootstrap closures (current user, toast, badge refresh).
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
