import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_ANDROID_APK_URL,
  APP_PLAY_STORE_URL,
  APP_RELEASES_API,
  APP_RELEASES_URL,
  findWindowsMsiUrl,
  orderAppPlatforms,
  recommendedAppPlatform,
  resolveWindowsMsiUrl,
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

describe('Windows installer lookup', () => {
  const msiUrl = 'https://github.com/TeamFlaxia/flaxia/releases/download/v0.1.200/Flaxia_0.1.0_x64_en-US.msi';

  it('finds the x64 MSI asset in a release', () => {
    assert.equal(
      findWindowsMsiUrl({
        assets: [
          { name: 'app-release.apk', browser_download_url: 'https://example.com/app-release.apk' },
          { name: 'Flaxia_0.1.0_x64_en-US.msi', browser_download_url: msiUrl },
        ],
      }),
      msiUrl,
    );
  });

  it('ignores non-MSI and untrusted assets', () => {
    assert.equal(findWindowsMsiUrl({ assets: [{ name: 'Flaxia_0.1.0_x64_en-US.zip' }] }), null);
    assert.equal(
      findWindowsMsiUrl({
        assets: [{ name: 'Flaxia_0.1.0_x64_en-US.msi', browser_download_url: 'https://example.com/evil.msi' }],
      }),
      null,
    );
    assert.equal(findWindowsMsiUrl(null), null);
  });

  it('resolves the latest release MSI URL', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return new Response(
        JSON.stringify({
          assets: [{ name: 'Flaxia_0.1.0_x64_en-US.msi', browser_download_url: msiUrl }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    assert.equal(await resolveWindowsMsiUrl(fetchImpl), msiUrl);
    assert.equal(requestedUrl, APP_RELEASES_API);
  });

  it('returns null when the release API is unavailable', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 403 })) as typeof fetch;
    assert.equal(await resolveWindowsMsiUrl(fetchImpl), null);
  });
});
