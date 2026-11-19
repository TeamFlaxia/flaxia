import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { injectBaseTag } from '../functions/lib/wvfs-zip-server.ts';
import { GAME_AUDIO_MUTE_MESSAGE, GAME_AUDIO_MUTE_RUNTIME } from '../sandbox/zip-preview-protocol.js';

test('WVFS HTML installs the audio mute runtime before game scripts', () => {
  const html = '<!doctype html><html><head><title>Game</title></head><body><script>bootGame()</script></body></html>';
  const injected = injectBaseTag(html, 'post-1');

  const runtimeAt = injected.indexOf(GAME_AUDIO_MUTE_RUNTIME);
  assert.ok(runtimeAt >= 0, 'the mute runtime must be injected');
  assert.ok(runtimeAt < injected.indexOf('bootGame()'), 'mute runtime must run before the game');
  assert.ok(
    injected.indexOf('<base href="/api/wvfs-zip/post-1/">') < runtimeAt,
    'the base tag must stay ahead of the runtime so lazy asset URLs resolve',
  );
});

test('the injected runtime mutes existing and newly created media', () => {
  const media: Array<{ muted: boolean }> = [{ muted: false }];
  let handler: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const parent = {};
  const document = {
    documentElement: {},
    querySelectorAll: () => media,
  };
  const window = {
    parent,
    addEventListener: (_type: string, callback: (event: { source: unknown; data: unknown }) => void) => {
      handler = callback;
    },
    MutationObserver: undefined,
  };

  runInNewContext(GAME_AUDIO_MUTE_RUNTIME, { window, document });
  assert.ok(handler, 'the runtime must listen for parent messages');

  handler({ source: parent, data: { type: GAME_AUDIO_MUTE_MESSAGE, muted: true } });
  assert.equal(media[0]?.muted, true);

  media.push({ muted: false });
  handler({ source: parent, data: { type: GAME_AUDIO_MUTE_MESSAGE, muted: true } });
  assert.equal(media[1]?.muted, true, 'media created later inherits the mute state');

  handler({ source: parent, data: { type: GAME_AUDIO_MUTE_MESSAGE, muted: false } });
  assert.equal(media[0]?.muted, false);
  assert.equal(media[1]?.muted, false);
});

test('messages from another window are ignored', () => {
  const media = [{ muted: false }];
  let handler: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const window = {
    parent: {},
    addEventListener: (_type: string, callback: (event: { source: unknown; data: unknown }) => void) => {
      handler = callback;
    },
    MutationObserver: undefined,
  };

  runInNewContext(GAME_AUDIO_MUTE_RUNTIME, {
    window,
    document: { documentElement: {}, querySelectorAll: () => media },
  });

  handler?.({ source: {}, data: { type: GAME_AUDIO_MUTE_MESSAGE, muted: true } });
  assert.equal(media[0]?.muted, false);
});

test('suspends tracked AudioContexts while muted', () => {
  const media = [{ muted: false }];
  let handler: ((event: { source: unknown; data: unknown }) => void) | null = null;

  class FakeAudioContext {
    state = 'running';
    suspend() {
      this.state = 'suspended';
    }
    resume() {
      this.state = 'running';
    }
  }

  const window: Record<string, unknown> = {
    parent: {},
    AudioContext: FakeAudioContext,
    addEventListener: (_type: string, callback: (event: { source: unknown; data: unknown }) => void) => {
      handler = callback;
    },
    MutationObserver: undefined,
  };

  runInNewContext(GAME_AUDIO_MUTE_RUNTIME, {
    window,
    document: { documentElement: {}, querySelectorAll: () => media },
    Reflect,
  });

  const AudioContextCtor = window.AudioContext as new () => FakeAudioContext;
  const context = new AudioContextCtor();
  assert.equal(context.state, 'running');

  handler?.({ source: window.parent, data: { type: GAME_AUDIO_MUTE_MESSAGE, muted: true } });
  assert.equal(context.state, 'suspended');

  handler?.({ source: window.parent, data: { type: GAME_AUDIO_MUTE_MESSAGE, muted: false } });
  assert.equal(context.state, 'running');
});
