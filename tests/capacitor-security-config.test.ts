import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8');

test('Capacitor retains bundled assets and only Android selects the first-party remote origin', () => {
  assert.match(config, /webDir:\s*'dist'/);
  assert.match(config, /CAPACITOR_PLATFORM === 'android'/);
  assert.match(config, /url: 'https:\/\/flaxia\.app'/);
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
