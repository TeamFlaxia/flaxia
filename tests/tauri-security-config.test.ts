import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../src-tauri/', import.meta.url);
const configs = ['tauri.conf.json', 'tauri.conf.base.json', 'tauri.conf.windows.json', 'tauri.conf.linux.json', 'tauri.conf.macos.json'];

test('Tauri never loads the public site as its privileged application UI', () => {
  for (const path of configs) {
    const cfg = JSON.parse(readFileSync(new URL(path, root), 'utf8'));
    if (cfg.build) {
      assert.equal(cfg.build.devUrl, 'http://localhost:3000', path);
      assert.equal(cfg.build.frontendDist, '../dist', path);
      assert.ok(cfg.app.security.csp, 'Tauri CSP must be enabled');
    }
    for (const window of cfg.app?.windows ?? []) {
      assert.equal(window.url, 'index.html', path);
      assert.equal(window.create, false, path);
    }
  }
});

test('Tauri navigation guards and native IPC capability remain local-only', () => {
  const rust = readFileSync(new URL('src/lib.rs', root), 'utf8');
  assert.match(rust, /on_navigation\(allow_app_navigation\)/);
  assert.match(rust, /NewWindowResponse::Deny/);
  const capabilities = readFileSync(new URL('capabilities/default.json', root), 'utf8');
  assert.doesNotMatch(capabilities, /"remote"\s*:/);
});
