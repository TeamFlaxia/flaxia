// urlBase64ToUint8Array: VAPID key decoding for Web Push registration.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { urlBase64ToUint8Array } from '../src/lib/web-push.ts';

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
