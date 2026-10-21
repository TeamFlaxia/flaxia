import assert from 'node:assert/strict';
import test from 'node:test';

// Capacitor's Android build should load the same first-party site as its API,
// so the Strict session cookie is first-party. Other platforms keep bundled
// assets and must not inherit the Android remote URL.
test('Android Capacitor config loads flaxia.app as the WebView origin', async () => {
  process.env.CAPACITOR_PLATFORM = 'android';
  const { default: androidConfig } = await import('../capacitor.config.ts?android-origin-test');
  assert.equal(androidConfig.server?.url, 'https://flaxia.app');

  delete process.env.CAPACITOR_PLATFORM;
  const { default: defaultConfig } = await import('../capacitor.config.ts?default-origin-test');
  assert.equal(defaultConfig.server?.url, undefined);
});
