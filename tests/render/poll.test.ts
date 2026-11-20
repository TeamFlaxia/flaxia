import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { castPollVote } from '../../src/lib/poll/vote.ts';
import { isPollExpired, shouldShowPollResults } from '../../src/lib/poll-state.ts';

function basePoll() {
  return {
    id: 'poll-1',
    question: 'Which one?',
    userVote: null,
    multipleChoice: false,
    endsAt: null,
    options: [
      { id: 'a', label: 'Alpha', votes_count: 3 },
      { id: 'b', label: 'Beta', votes_count: 1 },
    ],
  };
}

describe('PollWidget state', () => {
  it('uses server expiry and timestamps', () => {
    assert.equal(isPollExpired(basePoll()), false);
    assert.equal(isPollExpired({ ...basePoll(), expired: true }), true);
    assert.equal(isPollExpired({ ...basePoll(), endsAt: '2020-01-01T00:00:00Z' }), true);
  });

  it('shows results to voters and after expiry', () => {
    assert.equal(shouldShowPollResults(basePoll(), false), false);
    assert.equal(shouldShowPollResults(basePoll(), true), true);
    assert.equal(shouldShowPollResults({ ...basePoll(), expired: true }, false), true);
  });
});

describe('castPollVote', () => {
  let originalFetch: typeof fetch;
  let requests: Array<{ url: string; body: string }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(
        JSON.stringify({
          options: [
            { id: 'a', label: 'Alpha', votes_count: 4 },
            { id: 'b', label: 'Beta', votes_count: 1 },
          ],
          userVote: 'a',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts the option and returns updated results', async () => {
    const result = await castPollVote('poll-1', 'a');
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/polls\/poll-1\/vote$/);
    assert.match(requests[0].body, /"optionId":"a"/);
    assert.equal(result?.userVote, 'a');
    assert.equal(result?.options[0].votes_count, 4);
  });

  it('returns null on a 409 conflict', async () => {
    globalThis.fetch = (async () => new Response('', { status: 409 })) as typeof fetch;
    assert.equal(await castPollVote('poll-1', 'a'), null);
  });
});
