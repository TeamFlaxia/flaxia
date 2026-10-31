import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_ANDROID_APK_URL,
  APP_PLAY_STORE_URL,
  APP_RELEASES_URL,
  orderAppPlatforms,
  recommendedAppPlatform,
} from '../src/lib/app-download.ts';

describe('recommendedAppPlatform', () => {
  it('recommends the installable platform that matches the device', () => {
    assert.equal(recommendedAppPlatform('android'), 'android');
    assert.equal(recommendedAppPlatform('windows'), 'windows');
    assert.equal(recommendedAppPlatform('linux'), 'linux');
  });

  it('has no recommendation for unsupported devices', () => {
    assert.equal(recommendedAppPlatform('other'), null);
  });
});

describe('orderAppPlatforms', () => {
  it('keeps the canonical order without a recommendation', () => {
    assert.deepEqual(orderAppPlatforms('other'), ['android', 'windows', 'linux']);
  });

  it('moves the recommended platform to the front', () => {
    assert.deepEqual(orderAppPlatforms('android'), ['android', 'windows', 'linux']);
    assert.deepEqual(orderAppPlatforms('windows'), ['windows', 'android', 'linux']);
    assert.deepEqual(orderAppPlatforms('linux'), ['linux', 'android', 'windows']);
  });
});

describe('app download URLs', () => {
  it('points platform downloads at the latest GitHub release', () => {
    assert.equal(APP_RELEASES_URL, 'https://github.com/TeamFlaxia/flaxia/releases/latest');
    assert.equal(APP_ANDROID_APK_URL, `${APP_RELEASES_URL}/download/app-release.apk`);
    assert.equal(APP_PLAY_STORE_URL, 'https://play.google.com/store/apps/details?id=app.flaxia.app');
  });
});
