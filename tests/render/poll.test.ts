import './setup.ts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createPollElement, type PollData } from '../../src/components/PollWidget.ts';

function basePoll(): PollData {
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PollWidget', () => {
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

  it('renders the poll and its options', () => {
    const element = createPollElement(basePoll());

    assert.equal(element.querySelector('.poll-question')?.textContent, 'Which one?');
    assert.equal(element.querySelectorAll('.poll-option').length, 2);
    assert.ok(element.querySelector('.post-poll-footer')?.textContent);
  });

  it('votes in place without replacing the option or the widget', async () => {
    const element = createPollElement(basePoll());
    const option = element.querySelector<HTMLElement>('.poll-option[aria-label="Alpha"]');
    const poll = element.querySelector('.post-poll');
    assert.ok(option);
    assert.ok(poll);
    assert.equal(option.getAttribute('role'), 'button');
    assert.equal(option.getAttribute('tabindex'), '0');

    option.dispatchEvent(new Event('click'));
    await tick();
    await tick();

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/polls\/poll-1\/vote$/);
    assert.match(requests[0].body, /"optionId":"a"/);

    assert.equal(element.querySelector('.poll-option[aria-label="Alpha"]'), option);
    assert.equal(element.querySelector('.post-poll'), poll);
    assert.equal(option.classList.contains('is-voted'), true);
    assert.equal(option.getAttribute('role'), null);
    assert.match(option.querySelector('.poll-option-pct')?.textContent ?? '', /80%/);
  });

  it('supports keyboard activation', async () => {
    const element = createPollElement(basePoll());
    const option = element.querySelector<HTMLElement>('.poll-option[aria-label="Beta"]');
    assert.ok(option);

    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    await tick();

    assert.equal(requests.length, 1);
    assert.match(requests[0].body, /"optionId":"b"/);
  });

  it('shows the ended state and hides interactivity', () => {
    const element = createPollElement({
      ...basePoll(),
      userVote: 'a',
      expired: true,
    });

    assert.ok(element.querySelector('.post-poll.is-expired'));
    assert.ok(element.querySelector('.poll-ended-badge'));
    assert.equal(element.querySelector('.poll-option.is-clickable'), null);
  });
});
