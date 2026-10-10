import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { androidVersionCode, patchAndroidVersionCode } from '../scripts/android-version-code.mjs';

function versionCode(tag: string): number {
  return Number(execFileSync('node', ['scripts/android-version-code.mjs', 'code', tag], { encoding: 'utf8' }).trim());
}

test('Android versionCode maps release tags monotonically with fixed-width components', () => {
  assert.equal(versionCode('v0.1.100'), 10100);
  assert.equal(versionCode('v0.1.101'), 10101);
  assert.equal(versionCode('v0.1.102'), 10102);
  assert.equal(versionCode('v1.0.0'), 1_000_000);
  assert.equal(androidVersionCode('v0.1.101'), 10101);
  assert.ok(versionCode('v0.1.101') > versionCode('v0.1.100'));
});

test('Android Gradle patch injects or replaces the app defaultConfig versionCode', () => {
  const generated = 'android { defaultConfig { applicationId "app.flaxia.app" } }';
  assert.match(patchAndroidVersionCode(generated, 10101), /defaultConfig \{\n\s+versionCode 10101/);

  const existing = 'android { defaultConfig { versionCode 1 } }';
  assert.match(patchAndroidVersionCode(existing, 10101), /versionCode 10101/);
});

test('Android versionCode rejects malformed or ambiguous tags', () => {
  for (const tag of ['0.1.101', 'v0.1', 'v0.100.0', 'v0.1.10000', 'v9999.0.0']) {
    const result = spawnSync('node', ['scripts/android-version-code.mjs', 'code', tag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${tag} should be rejected`);
  }
});
