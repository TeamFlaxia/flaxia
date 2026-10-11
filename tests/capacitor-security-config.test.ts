import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8');

test('production Capacitor builds use bundled assets instead of remote pages', () => {
  assert.match(config, /webDir:\s*'dist'/);
  assert.doesNotMatch(config, /\burl:\s*['"]https?:\/\//);
});

test('privileged WebView does not allow remote site navigation', () => {
  assert.doesNotMatch(config, /allowNavigation\s*:/);
});
