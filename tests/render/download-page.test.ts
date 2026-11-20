import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderAppPlatforms, recommendedAppPlatform } from '../../src/lib/app-download.ts';

describe('DownloadPage platform helpers', () => {
  it('recommends the current platform', () => {
    assert.equal(recommendedAppPlatform('linux'), 'linux');
    assert.equal(recommendedAppPlatform('android'), 'android');
    assert.equal(recommendedAppPlatform('windows'), 'windows');
    assert.equal(recommendedAppPlatform('unknown'), null);
  });

  it('orders the three platforms with the current one first', () => {
    assert.deepEqual(orderAppPlatforms('android'), ['android', 'windows', 'linux']);
    assert.deepEqual(orderAppPlatforms('linux'), ['linux', 'android', 'windows']);
    assert.equal(orderAppPlatforms('unknown').length, 3);
  });
});
