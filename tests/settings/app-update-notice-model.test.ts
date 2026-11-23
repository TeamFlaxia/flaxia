import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appUpdateNoticeHref } from '../../src/lib/svelte/app-update-notice-model.ts';

const update = {
  releaseUrl: 'https://github.com/TeamFlaxia/flaxia/releases/tag/v9.9.9',
  windowsMsiUrl: 'https://github.com/TeamFlaxia/flaxia/releases/download/v9.9.9/flaxia.msi',
};

describe('svelte/app-update-notice-model', () => {
  it('prefers the MSI installer on Windows', () => {
    assert.equal(appUpdateNoticeHref(update, 'windows'), update.windowsMsiUrl);
  });

  it('falls back to the release page when the MSI is missing', () => {
    assert.equal(appUpdateNoticeHref({ ...update, windowsMsiUrl: null }, 'windows'), update.releaseUrl);
  });

  it('uses the release page on Linux and unknown platforms', () => {
    assert.equal(appUpdateNoticeHref(update, 'linux'), update.releaseUrl);
    assert.equal(appUpdateNoticeHref(update, null), update.releaseUrl);
  });
});
