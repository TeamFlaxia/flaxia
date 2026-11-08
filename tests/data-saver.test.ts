import assert from 'node:assert';
import { describe, it } from 'node:test';

// Node has no DOM; settings.ts must degrade gracefully (no localStorage /
// navigator / window). These tests cover the constants and the pure fallbacks.
import {
  DATA_SAVER_AD_SPACING_MULTIPLIER,
  FOR_YOU_BATCH_SIZE_DATA_SAVER,
  FOR_YOU_BATCH_SIZE_NORMAL,
  getDataSaverMode,
  getForYouBatchSize,
  getTimelinePageSize,
  isBrowserSaveDataEnabled,
  isDataSaverEnabled,
  TIMELINE_PAGE_SIZE_DATA_SAVER,
  TIMELINE_PAGE_SIZE_NORMAL,
} from '../src/lib/settings.ts';

describe('data-saver constants', () => {
  it('halves timeline page size in data-saver mode', () => {
    assert.equal(TIMELINE_PAGE_SIZE_NORMAL, 20);
    assert.equal(TIMELINE_PAGE_SIZE_DATA_SAVER, 10);
  });

  it('reduces ForYou batch size in data-saver mode', () => {
    assert.equal(FOR_YOU_BATCH_SIZE_NORMAL, 100);
    assert.equal(FOR_YOU_BATCH_SIZE_DATA_SAVER, 30);
  });

  it('deprioritizes ads by spacing multiplier', () => {
    assert.ok(DATA_SAVER_AD_SPACING_MULTIPLIER > 1);
  });
});

describe('data-saver getters without DOM', () => {
  it('defaults to off without localStorage', () => {
    assert.equal(getDataSaverMode(), false);
  });

  it('reports no browser Save-Data without navigator', () => {
    assert.equal(isBrowserSaveDataEnabled(), false);
  });

  it('is disabled by default without DOM', () => {
    assert.equal(isDataSaverEnabled(), false);
    assert.equal(getTimelinePageSize(), TIMELINE_PAGE_SIZE_NORMAL);
    assert.equal(getForYouBatchSize(), FOR_YOU_BATCH_SIZE_NORMAL);
  });
});
