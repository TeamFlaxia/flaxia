import assert from 'node:assert/strict';
import test from 'node:test';

// Every native build boots bundled assets while the native HTTP cookie jar
// authenticates production API requests. A platform override must not restore
// remote-only startup or privilege arbitrary remote WebViews.
for (const platform of ['android', 'ios', undefined]) {
  test((platform ?? 'default') + ' Capacitor config boots offline with native session transport', async () => {
    const previousPlatform = process.env.CAPACITOR_PLATFORM;
    try {
      if (platform) process.env.CAPACITOR_PLATFORM = platform;
      else delete process.env.CAPACITOR_PLATFORM;
      const { default: config } = await import('../capacitor.config.ts?offline-origin-' + (platform ?? 'default'));
      assert.equal(config.webDir, 'dist');
      assert.equal(config.server?.url, undefined);
      assert.equal(config.plugins?.CapacitorHttp?.enabled, true);
      assert.equal(config.server?.allowNavigation, undefined);
    } finally {
      if (previousPlatform === undefined) delete process.env.CAPACITOR_PLATFORM;
      else process.env.CAPACITOR_PLATFORM = previousPlatform;
    }
  });
}
