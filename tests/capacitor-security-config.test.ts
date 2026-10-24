import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8');

test('all Capacitor platforms boot bundled assets with cookie-aware native HTTP', () => {
  assert.match(config, /webDir:\s*'dist'/);
  assert.doesNotMatch(config, /url:\s*'https?:/);
  assert.match(config, /CapacitorHttp:\s*\{\s*enabled:\s*true/);
});

test('desktop apps boot local assets with first-party-only HTTP permissions', () => {
  for (const os of ['windows', 'macos', 'linux']) {
    const desktop = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.' + os + '.json', import.meta.url), 'utf8'),
    );
    assert.equal(desktop.app.windows[0].url, 'index.html');
  }
  const capabilities = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  );
  const http = capabilities.permissions.find(
    (permission: unknown) =>
      typeof permission === 'object' &&
      permission !== null &&
      'identifier' in permission &&
      permission.identifier === 'http:default',
  );
  assert.deepEqual(http.allow, [{ url: 'https://flaxia.app/api/*' }]);
  assert.equal(capabilities.remote, undefined);
});

test('privileged WebView does not allow remote site navigation', () => {
  assert.doesNotMatch(config, /allowNavigation\s*:/);
});

test('Android navigation guard distinguishes sandboxed frames from the privileged app window', () => {
  const activity = readFileSync(new URL('../scripts/android-main-activity.java', import.meta.url), 'utf8');
  assert.match(activity, /if \(!request.isForMainFrame\(\)\) return false/);
  assert.match(activity, /return super.shouldOverrideUrlLoading\(view, request\)/);
  const patch = readFileSync(new URL('../scripts/patch-android-build.mjs', import.meta.url), 'utf8');
  assert.match(patch, /copyFileSync\(resolve\('scripts\/android-main-activity.java'\), mainActivityPath\)/);
});
