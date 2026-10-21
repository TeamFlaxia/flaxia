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
