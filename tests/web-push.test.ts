// urlBase64ToUint8Array: VAPID key decoding for Web Push registration.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initializeWebPush, registerPushToken, urlBase64ToUint8Array } from '../src/lib/web-push.ts';

describe('urlBase64ToUint8Array', () => {
  it('decodes standard base64', () => {
    assert.deepEqual(urlBase64ToUint8Array('aGVsbG8'), Uint8Array.from([104, 101, 108, 108, 111]));
  });

  it('handles base64url characters without padding', () => {
    // 0xfb 0xff 0xff -> base64url "-___" (no padding)
    assert.deepEqual(urlBase64ToUint8Array('-___'), Uint8Array.from([251, 255, 255]));
  });

  it('decodes an empty string to empty bytes', () => {
    assert.deepEqual(urlBase64ToUint8Array(''), new Uint8Array(0));
  });
});

describe('registerPushToken / initializeWebPush', () => {
  // Node's globalThis.navigator is getter-only: override via defineProperty.
  const stubNavigator = (value: unknown): void => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  };

  it('does nothing without Service Worker support', async () => {
    let fetched = false;
    (globalThis as unknown as Record<string, unknown>).fetch = async () => {
      fetched = true;
      throw new Error('must not fetch');
    };
    // Bare navigator without serviceWorker: early return before any fetch.
    stubNavigator({});
    await registerPushToken();
    assert.equal(fetched, false);
  });

  it('skips on Tauri and Capacitor', async () => {
    let fetched = false;
    (globalThis as unknown as Record<string, unknown>).fetch = async () => {
      fetched = true;
      throw new Error('must not fetch');
    };
    (globalThis as unknown as Record<string, unknown>).window = { __TAURI__: {} };
    stubNavigator({});
    try {
      await initializeWebPush(false);
      assert.equal(fetched, false);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).window;
    }
    stubNavigator({});
    await initializeWebPush(true);
    assert.equal(fetched, false);
  });
});
