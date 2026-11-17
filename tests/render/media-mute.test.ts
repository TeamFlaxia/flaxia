import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAME_AUDIO_MUTE_MESSAGE } from '../../sandbox/zip-preview-protocol.js';
import { pauseMediaIn, setMediaMuted } from '../../src/lib/media-mute.ts';

describe('media mute', () => {
  it('mutes and restores native media without overriding a user mute', () => {
    const root = document.createElement('div');
    const video = document.createElement('video');
    const audio = document.createElement('audio');
    video.muted = false;
    audio.muted = true;
    root.append(video, audio);

    setMediaMuted(root, true);
    assert.equal(video.muted, true);
    assert.equal(audio.muted, true);

    setMediaMuted(root, false);
    assert.equal(video.muted, false);
    assert.equal(audio.muted, true, 'a user-muted player must stay muted');
  });

  it('sends the typed mute message to sandbox frames', () => {
    const root = document.createElement('div');
    const iframe = document.createElement('iframe');
    const messages: unknown[] = [];
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: {
        postMessage: (message: unknown) => {
          messages.push(message);
        },
      },
    });
    root.appendChild(iframe);

    setMediaMuted(root, true);
    setMediaMuted(root, false);

    assert.deepEqual(messages, [
      { type: GAME_AUDIO_MUTE_MESSAGE, muted: true },
      { type: GAME_AUDIO_MUTE_MESSAGE, muted: false },
    ]);
  });

  it('mutes a Ruffle player and restores its previous volume', () => {
    const root = document.createElement('div');
    const player = document.createElement('ruffle-player') as HTMLElement & { volume?: number };
    player.volume = 0.4;
    root.appendChild(player);

    setMediaMuted(root, true);
    assert.equal(player.volume, 0);

    setMediaMuted(root, false);
    assert.equal(player.volume, 0.4);
  });

  it('pauses detached media when a parked view is discarded', () => {
    const root = document.createElement('div');
    let paused = 0;
    const video = document.createElement('video');
    video.pause = () => {
      paused += 1;
    };
    root.appendChild(video);

    pauseMediaIn(root);
    assert.equal(paused, 1);
  });
});
