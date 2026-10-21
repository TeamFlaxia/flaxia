// spa-history: in-app history tagging and back fallback.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { goBackInSpaOr, isSpaHistoryEntry, pushSpaHistory, SPA_HISTORY_STATE_KEY } from '../src/lib/spa-history.ts';

interface FakeHistory {
  state: unknown;
  pushes: Array<{ state: Record<string, unknown>; url: string }>;
  backCalls: number;
  pushState: (state: Record<string, unknown>, _title: string, url: string) => void;
  back: () => void;
}

function installWindow(initialState: unknown = null): FakeHistory {
  const history: FakeHistory = {
    state: initialState,
    pushes: [],
    backCalls: 0,
    pushState: (state, _title, url) => {
      history.pushes.push({ state, url });
      history.state = state;
    },
    back: () => {
      history.backCalls++;
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = { history };
  return history;
}

describe('spa-history', () => {
  it('tags pushed entries and preserves caller state', () => {
    const history = installWindow();
    pushSpaHistory('/arcade/post-1', { postId: 'post-1' });

    assert.deepEqual(history.pushes, [
      { state: { postId: 'post-1', [SPA_HISTORY_STATE_KEY]: true }, url: '/arcade/post-1' },
    ]);
    assert.equal(isSpaHistoryEntry(history.state), true);
  });

  it('treats untagged entries as direct loads', () => {
    installWindow();
    assert.equal(isSpaHistoryEntry(null), false);
    assert.equal(isSpaHistoryEntry({}), false);
    assert.equal(isSpaHistoryEntry({ postId: 'post-1' }), false);
  });

  it('goes back for SPA entries', () => {
    const history = installWindow({ [SPA_HISTORY_STATE_KEY]: true });
    let fallbackCalls = 0;
    goBackInSpaOr(() => {
      fallbackCalls++;
    });

    assert.equal(history.backCalls, 1);
    assert.equal(fallbackCalls, 0);
  });

  it('uses the fallback for direct loads', () => {
    const history = installWindow();
    let fallbackCalls = 0;
    goBackInSpaOr(() => {
      fallbackCalls++;
    });

    assert.equal(history.backCalls, 0);
    assert.equal(fallbackCalls, 1);
  });
});
