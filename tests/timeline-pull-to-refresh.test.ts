import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerModal } from '../src/lib/modal-state.ts';
import {
  PULL_MAX_DISTANCE,
  PULL_THRESHOLD,
  pullProgress,
  setupPullToRefresh,
  shouldTriggerRefresh,
} from '../src/lib/timeline/pull-to-refresh.ts';

interface FakeTouchEvent {
  touches: Array<{ clientX: number; clientY: number }>;
  target: unknown;
  prevented: number;
  preventDefault: () => void;
}

interface ListenerRecord {
  type: string;
  listener: (event: FakeTouchEvent) => void;
  options?: AddEventListenerOptions;
}

interface FakeRoot {
  records: ListenerRecord[];
  removals: ListenerRecord[];
  addEventListener: (
    type: string,
    listener: (event: FakeTouchEvent) => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: FakeTouchEvent) => void,
    options?: AddEventListenerOptions,
  ) => void;
  emit: (type: string, event: FakeTouchEvent) => void;
}

function makeTouchEvent(clientX: number, clientY: number, target: unknown = null): FakeTouchEvent {
  const event: FakeTouchEvent = {
    touches: [{ clientX, clientY }],
    target,
    prevented: 0,
    preventDefault: () => {
      event.prevented += 1;
    },
  };
  return event;
}

function makeRoot(): FakeRoot {
  const records: ListenerRecord[] = [];
  const removals: ListenerRecord[] = [];
  return {
    records,
    removals,
    addEventListener(type, listener, options) {
      records.push({ type, listener, options });
    },
    removeEventListener(type, listener, options) {
      removals.push({ type, listener, options });
      const index = records.findIndex((record) => record.type === type && record.listener === listener);
      if (index >= 0) records.splice(index, 1);
    },
    emit(type, event) {
      for (const record of records) {
        if (record.type === type) record.listener(event);
      }
    },
  };
}

function withScrollY<T>(scrollY: number, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { scrollY } });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

/** A mutable scroll position, so a scroll can be simulated mid-gesture. */
function withMutableScrollY<T>(run: (win: { scrollY: number }) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = { scrollY: 0, scrollTo: () => undefined, dispatchEvent: () => true };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  try {
    return run(win);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function withDocument<T>(style: { overflow: string }, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body: { style } },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function withClock<T>(run: (advance: (ms: number) => void) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let time = 1000;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time } });
  try {
    return run((ms) => {
      time += ms;
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'performance', previous);
    else Reflect.deleteProperty(globalThis, 'performance');
  }
}

/** Minimal DOM-like target: closest() matches class selectors only. */
function makeClassTarget(classes: string[]): unknown {
  return {
    closest(selector: string) {
      return selector
        .split(',')
        .map((part) => part.trim())
        .some((part) => part.startsWith('.') && classes.includes(part.slice(1)))
        ? {}
        : null;
    },
  };
}

test('pullProgress halves downward distance and caps at the maximum', () => {
  assert.equal(PULL_THRESHOLD, 64);
  assert.equal(PULL_MAX_DISTANCE, 96);
  assert.equal(pullProgress(20, 0), 10);
  assert.equal(pullProgress(130, 0), 65);
  assert.equal(pullProgress(192, 0), PULL_MAX_DISTANCE);
  assert.equal(pullProgress(400, 12), PULL_MAX_DISTANCE);
});

test('pullProgress rejects upward and horizontal-dominant gestures', () => {
  assert.equal(pullProgress(-50, 0), 0);
  assert.equal(pullProgress(0, 30), 0);
  assert.equal(pullProgress(30, 31), 0);
  assert.equal(pullProgress(30, 30), 15, 'an exactly diagonal move is not horizontal-dominant');
});

test('shouldTriggerRefresh accepts a full pull or a quick short flick', () => {
  assert.equal(shouldTriggerRefresh(PULL_THRESHOLD, 0), true);
  assert.equal(shouldTriggerRefresh(PULL_THRESHOLD - 1, 0), false);
  assert.equal(shouldTriggerRefresh(24, 0.5), true);
  assert.equal(shouldTriggerRefresh(24, 0.49), false);
  assert.equal(shouldTriggerRefresh(23, 5), false);
});

test('no refresh or preventDefault while the document is scrolled down', () => {
  withScrollY(120, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    const start = makeTouchEvent(100, 100);
    const move = makeTouchEvent(100, 240);
    root.emit('touchstart', start);
    root.emit('touchmove', move);
    root.emit('touchend', makeTouchEvent(100, 240));

    assert.equal(refreshes, 0);
    assert.equal(start.prevented, 0, 'touchstart must never be prevented');
    assert.equal(move.prevented, 0);
    assert.deepEqual(progress, []);
    cleanup();
  });
});

test('no refresh for a horizontal or horizontal-dominant swipe', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    const horizontal = makeTouchEvent(230, 100);
    const dominant = makeTouchEvent(230, 130);
    root.emit('touchmove', horizontal);
    root.emit('touchmove', dominant);
    root.emit('touchend', makeTouchEvent(230, 130));

    assert.equal(refreshes, 0);
    assert.equal(horizontal.prevented, 0);
    assert.equal(dominant.prevented, 0);
    assert.deepEqual(progress, [[0, false]], 'the gesture still ends with a progress reset');
    cleanup();
  });
});

test('a downward pull past the threshold refreshes exactly once', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    const move = makeTouchEvent(100, 230);
    root.emit('touchmove', move);
    root.emit('touchend', makeTouchEvent(100, 230));

    assert.equal(refreshes, 1);
    assert.equal(move.prevented, 1, 'an active downward pull must block native scroll');
    assert.deepEqual(progress, [
      [65, true],
      [0, false],
    ]);

    root.emit('touchend', makeTouchEvent(100, 230));
    assert.equal(refreshes, 1, 'a repeated end event must not refresh twice');
    cleanup();
  });
});

test('a short but fast flick refreshes based on velocity', () => {
  withScrollY(0, () => {
    withClock((advance) => {
      const root = makeRoot();
      const progress: Array<[number, boolean]> = [];
      let refreshes = 0;
      const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
        onRefresh: () => {
          refreshes += 1;
        },
        onProgress: (distance, armed) => {
          progress.push([distance, armed]);
        },
      });

      root.emit('touchstart', makeTouchEvent(100, 100));
      advance(10);
      root.emit('touchmove', makeTouchEvent(100, 140));
      advance(10);
      root.emit('touchmove', makeTouchEvent(100, 150));
      root.emit('touchend', makeTouchEvent(100, 150));

      assert.equal(refreshes, 1, '25px over 10ms should trip the velocity path');
      assert.deepEqual(progress, [
        [20, false],
        [25, false],
        [0, false],
      ]);
      cleanup();
    });
  });
});

test('touchcancel reports progress zero but never refreshes', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    root.emit('touchmove', makeTouchEvent(100, 230));
    root.emit('touchcancel', makeTouchEvent(100, 230));
    root.emit('touchend', makeTouchEvent(100, 230));

    assert.equal(refreshes, 0);
    assert.deepEqual(progress, [
      [65, true],
      [0, false],
    ]);
    cleanup();
  });
});

test('pulls are ignored inside form controls and while the body is scroll-locked', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
    });

    const interactiveTarget = { closest: () => ({}) };
    root.emit('touchstart', makeTouchEvent(100, 100, interactiveTarget));
    root.emit('touchmove', makeTouchEvent(100, 230, interactiveTarget));
    root.emit('touchend', makeTouchEvent(100, 230, interactiveTarget));
    assert.equal(refreshes, 0, 'a pull started in a form control must be ignored');

    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { body: { style: { overflow: 'hidden' } } },
    });
    try {
      root.emit('touchstart', makeTouchEvent(100, 100));
      root.emit('touchmove', makeTouchEvent(100, 230));
      root.emit('touchend', makeTouchEvent(100, 230));
      assert.equal(refreshes, 0, 'a locked body must not accept a pull');
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
    cleanup();
  });
});

test('cleanup removes all four listeners and resets gesture state', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
    });

    const attached = root.records.slice();
    assert.deepEqual(
      attached.map((record) => record.type),
      ['touchstart', 'touchmove', 'touchend', 'touchcancel'],
    );

    root.emit('touchstart', makeTouchEvent(100, 100));
    cleanup();

    assert.equal(root.removals.length, 4);
    assert.deepEqual(
      root.removals.map((record) => record.type),
      ['touchstart', 'touchmove', 'touchend', 'touchcancel'],
    );
    assert.ok(
      root.removals.every((record) =>
        attached.some((item) => item.type === record.type && item.listener === record.listener),
      ),
      'cleanup must remove the exact listeners it attached',
    );

    root.emit('touchmove', makeTouchEvent(100, 230));
    root.emit('touchend', makeTouchEvent(100, 230));
    assert.equal(refreshes, 0, 'no gesture may survive cleanup');
  });
});

test('touchmove is registered as a non-passive listener', () => {
  const root = makeRoot();
  const cleanup = setupPullToRefresh(root as unknown as HTMLElement, { onRefresh: () => {} });

  const move = root.records.find((record) => record.type === 'touchmove');
  assert.deepEqual(move?.options, { passive: false }, 'touchmove must be able to preventDefault');
  const start = root.records.find((record) => record.type === 'touchstart');
  assert.deepEqual(start?.options, { passive: true });
  for (const type of ['touchend', 'touchcancel']) {
    assert.equal(root.records.find((record) => record.type === type)?.options, undefined);
  }

  cleanup();
  assert.deepEqual(
    root.removals.find((record) => record.type === 'touchmove')?.options,
    { passive: false },
    'cleanup must unregister with the same options',
  );
});

test('dragging back to the start cancels an armed pull', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    const armed = makeTouchEvent(100, 230);
    root.emit('touchmove', armed);
    assert.equal(armed.prevented, 1);

    const backToStart = makeTouchEvent(100, 100);
    root.emit('touchmove', backToStart);
    root.emit('touchmove', makeTouchEvent(100, 105));
    root.emit('touchend', makeTouchEvent(100, 105));

    assert.equal(refreshes, 0, 'a pull dragged back to the start must not refresh on release');
    assert.deepEqual(progress, [
      [65, true],
      [0, false],
    ]);
    cleanup();
  });
});

test('horizontal-dominant moves cancel the pull, but small horizontal drift is tolerated', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    root.emit('touchmove', makeTouchEvent(100, 230));
    const sideways = makeTouchEvent(300, 250);
    root.emit('touchmove', sideways);
    root.emit('touchend', makeTouchEvent(300, 250));
    assert.equal(refreshes, 0, 'a horizontal-dominant move must cancel the armed pull');
    assert.equal(sideways.prevented, 0);

    root.emit('touchstart', makeTouchEvent(100, 100));
    root.emit('touchmove', makeTouchEvent(100, 160));
    root.emit('touchmove', makeTouchEvent(105, 163)); // 5px drift is jitter, not a swipe
    root.emit('touchmove', makeTouchEvent(105, 230));
    root.emit('touchend', makeTouchEvent(105, 230));
    assert.equal(refreshes, 1, 'minor finger drift must not kill a valid pull');
    cleanup();
  });
});

test('tolerated horizontal jitter after arming cannot refresh on release', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    root.emit('touchmove', makeTouchEvent(100, 230)); // armed at 65px
    root.emit('touchmove', makeTouchEvent(107, 106)); // dy=6, dx=7: tolerated jitter
    root.emit('touchend', makeTouchEvent(107, 106));

    assert.equal(refreshes, 0, 'dragging back to near the start must not refresh on release');
    assert.deepEqual(progress, [
      [65, true],
      [0, false],
      [0, false],
    ]);
    cleanup();
  });
});

test('a seekbar target does not start a pull', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
    });

    for (const className of [
      'audio-player-seekbar',
      'audio-player-seekbar-row',
      'video-player-seekbar',
      'video-player-seekbar-row',
    ]) {
      const target = makeClassTarget([className]);
      root.emit('touchstart', makeTouchEvent(100, 100, target));
      const move = makeTouchEvent(100, 230, target);
      root.emit('touchmove', move);
      root.emit('touchend', makeTouchEvent(100, 230, target));
      assert.equal(refreshes, 0, `${className} must never start a pull`);
      assert.equal(move.prevented, 0);
    }

    root.emit('touchstart', makeTouchEvent(100, 100, makeClassTarget(['timeline-post'])));
    root.emit('touchmove', makeTouchEvent(100, 230));
    root.emit('touchend', makeTouchEvent(100, 230));
    assert.equal(refreshes, 1, 'ordinary targets must still be pullable');
    cleanup();
  });
});

test('a second finger cancels the active pull', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const progress: Array<[number, boolean]> = [];
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
      onProgress: (distance, armed) => {
        progress.push([distance, armed]);
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    root.emit('touchmove', makeTouchEvent(100, 230));
    const secondFinger = makeTouchEvent(100, 240);
    secondFinger.touches.push({ clientX: 200, clientY: 240 });
    root.emit('touchmove', secondFinger);
    root.emit('touchend', makeTouchEvent(100, 240));

    assert.equal(refreshes, 0, 'a multi-touch move must cancel the pull');
    assert.equal(secondFinger.prevented, 0);
    assert.deepEqual(progress, [
      [65, true],
      [0, false],
    ]);
    cleanup();
  });
});

test('stale velocity after a pause does not trigger the quick-flick path', () => {
  withScrollY(0, () => {
    withClock((advance) => {
      const root = makeRoot();
      let refreshes = 0;
      const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
        onRefresh: () => {
          refreshes += 1;
        },
      });

      root.emit('touchstart', makeTouchEvent(100, 100));
      advance(10);
      root.emit('touchmove', makeTouchEvent(100, 140));
      advance(10);
      root.emit('touchmove', makeTouchEvent(100, 150));
      advance(200);
      root.emit('touchend', makeTouchEvent(100, 150));

      assert.equal(refreshes, 0, 'a 25px pull whose last move was 200ms ago is not a quick flick');
      cleanup();
    });
  });
});

test('tiny movements do not preventDefault until the pull is intentional', () => {
  withScrollY(0, () => {
    const root = makeRoot();
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, { onRefresh: () => {} });

    root.emit('touchstart', makeTouchEvent(100, 100));
    const onePixel = makeTouchEvent(100, 101);
    const belowThreshold = makeTouchEvent(100, 115);
    const atThreshold = makeTouchEvent(100, 116);
    root.emit('touchmove', onePixel);
    root.emit('touchmove', belowThreshold);
    root.emit('touchmove', atThreshold);

    assert.equal(onePixel.prevented, 0, '1px of jitter is untouched');
    assert.equal(belowThreshold.prevented, 0, 'resisted distance below 8px is untouched');
    assert.equal(atThreshold.prevented, 1, 'preventDefault starts at 8px of resisted distance');
    cleanup();
  });
});

test('a body scroll lock appearing mid-pull cancels the gesture', () => {
  withScrollY(0, () => {
    const style = { overflow: '' };
    withDocument(style, () => {
      const root = makeRoot();
      let refreshes = 0;
      const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
        onRefresh: () => {
          refreshes += 1;
        },
      });

      root.emit('touchstart', makeTouchEvent(100, 100));
      root.emit('touchmove', makeTouchEvent(100, 230));
      style.overflow = 'hidden';
      root.emit('touchmove', makeTouchEvent(100, 240));
      root.emit('touchend', makeTouchEvent(100, 240));
      assert.equal(refreshes, 0, 'a scroll lock opened during the pull must cancel it');
      cleanup();
    });
  });
});

test('a modal opened mid-pull cancels the gesture', () => {
  withMutableScrollY(() => {
    const style = { overflow: '' };
    withDocument(style, () => {
      const root = makeRoot();
      let refreshes = 0;
      const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
        onRefresh: () => {
          refreshes += 1;
        },
      });

      root.emit('touchstart', makeTouchEvent(100, 100));
      root.emit('touchmove', makeTouchEvent(100, 230));
      const unregister = registerModal();
      // Isolate the modal gate from the scroll-lock gate registerModal() sets.
      style.overflow = '';
      try {
        root.emit('touchmove', makeTouchEvent(100, 240));
        root.emit('touchend', makeTouchEvent(100, 240));
        assert.equal(refreshes, 0, 'opening a modal during the pull must cancel it');
      } finally {
        unregister();
        cleanup();
      }
    });
  });
});

test('a real scroll during a pull cancels it, while tiny drift is tolerated', () => {
  withMutableScrollY((win) => {
    const root = makeRoot();
    let refreshes = 0;
    const cleanup = setupPullToRefresh(root as unknown as HTMLElement, {
      onRefresh: () => {
        refreshes += 1;
      },
    });

    root.emit('touchstart', makeTouchEvent(100, 100));
    root.emit('touchmove', makeTouchEvent(100, 230));
    win.scrollY = 4;
    const drifted = makeTouchEvent(100, 240);
    root.emit('touchmove', drifted);
    assert.equal(drifted.prevented, 0, 'no preventDefault once the document has scrolled at all');
    win.scrollY = 8;
    root.emit('touchmove', makeTouchEvent(100, 250));
    root.emit('touchend', makeTouchEvent(100, 250));
    assert.equal(refreshes, 0, 'scrolling away from the top must cancel the pull');
    cleanup();
  });
});
