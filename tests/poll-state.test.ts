import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isPollExpired, shouldShowPollResults } from '../src/lib/poll-state.ts';

const NOW = Date.parse('2026-10-23T00:00:00.000Z');

describe('poll result visibility', () => {
  it('shows results to non-voters after the end time', () => {
    const poll = { endsAt: '2026-10-22T23:59:59.000Z', expired: false };
    assert.equal(isPollExpired(poll, NOW), true);
    assert.equal(shouldShowPollResults(poll, false, NOW), true);
  });

  it('honors the server expired flag when the client clock is behind', () => {
    const poll = { endsAt: '2026-10-24T00:00:00.000Z', expired: true };
    assert.equal(isPollExpired(poll, NOW), true);
    assert.equal(shouldShowPollResults(poll, false, NOW), true);
  });

  it('keeps results hidden from non-voters while the poll is open', () => {
    const poll = { endsAt: '2026-10-24T00:00:00.000Z', expired: false };
    assert.equal(shouldShowPollResults(poll, false, NOW), false);
  });

  it('continues to show results to voters while the poll is open', () => {
    const poll = { endsAt: '2026-10-24T00:00:00.000Z', expired: false };
    assert.equal(shouldShowPollResults(poll, true, NOW), true);
  });

  it('treats a poll without an end time as open unless the server marked it expired', () => {
    assert.equal(isPollExpired({}, NOW), false);
    assert.equal(isPollExpired({ expired: true }, NOW), true);
  });
});
