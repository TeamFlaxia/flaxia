import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportStudioProject, importStudioProject } from '../src/lib/editor/studio-project-store.ts';

describe('portable Studio projects', () => {
  it('round-trips code, game, image, audio, and video assets with their edit references', async () => {
    const files = [
      new File(['<canvas id="game"></canvas>'], 'game.html', { type: 'text/html' }),
      new File(['PK\u0003\u0004game-package'], 'game.zip', { type: 'application/zip' }),
      new File([new Uint8Array([1, 2, 3])], 'art.png', { type: 'image/png' }),
      new File([new Uint8Array([4, 5, 6])], 'music.wav', { type: 'audio/wav' }),
      new File([new Uint8Array([7, 8, 9])], 'scene.mp4', { type: 'video/mp4' }),
    ];
    const audioClips = [
      {
        id: 'audio-1',
        fileIndex: 3,
        track: 0,
        start: 1.5,
        sourceStart: 0.25,
        sourceEnd: 2.75,
        speed: 1.25,
        gain: 0.8,
        fadeIn: 0.5,
        fadeOut: 0.75,
        pan: -0.2,
        muted: false,
      },
    ];
    const videoClips = [
      {
        id: 'video-1',
        fileIndex: 4,
        start: 0,
        sourceStart: 1,
        sourceEnd: 5,
        speed: 0.8,
        fit: 'cover' as const,
        transitionOut: 1.2,
        transitionType: 'wipeleft' as const,
      },
      {
        id: 'video-pip',
        fileIndex: 4,
        start: 1.5,
        sourceStart: 0.5,
        sourceEnd: 3.5,
        track: 'overlay' as const,
        transitionOut: 1,
      },
    ];
    const imageLayers = [
      {
        id: 'image-1',
        kind: 'image' as const,
        fileIndex: 2,
        x: 100,
        y: 120,
        width: 640,
        height: 360,
        rotation: 12,
        opacity: 0.7,
        visible: true,
        blend: 'screen' as const,
        paintLayer: true,
        start: 1,
        end: 4,
      },
      {
        id: 'caption-1',
        kind: 'text' as const,
        fileIndex: -1,
        x: 80,
        y: 540,
        width: 920,
        height: 100,
        rotation: 0,
        opacity: 1,
        visible: true,
        blend: 'normal' as const,
        text: 'Studio project',
        color: '#ffffff',
        fontSize: 48,
        fontFamily: 'sans-serif' as const,
      },
    ];

    const portable = await exportStudioProject(
      files,
      audioClips,
      videoClips,
      imageLayers,
      'studio-round-trip-key',
      'portrait',
    );
    const restored = await importStudioProject(portable, 'studio-round-trip-key');

    assert.deepEqual(
      restored.files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
      files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    );
    for (let index = 0; index < files.length; index++) {
      assert.deepEqual(
        new Uint8Array(await restored.files[index].arrayBuffer()),
        new Uint8Array(await files[index].arrayBuffer()),
      );
    }
    assert.equal(restored.audioClips[0].fileIndex, 3);
    assert.equal(restored.audioClips[0].speed, 1.25);
    assert.equal(restored.videoClips[0].fileIndex, 4);
    assert.equal(restored.videoClips[0].fit, 'cover');
    assert.equal(restored.videoClips[0].transitionOut, 1.2);
    assert.equal(restored.videoClips[0].transitionType, 'wipeleft');
    assert.equal(restored.videoClips[0].track, 'main');
    assert.equal(restored.videoClips[1].track, 'overlay');
    assert.equal(restored.videoClips[1].transitionOut, 0);
    assert.equal(restored.videoFormat, 'portrait');
    assert.equal(restored.imageLayers[0].fileIndex, 2);
    assert.equal(restored.imageLayers[0].blend, 'screen');
    assert.equal(restored.imageLayers[0].paintLayer, true);
    assert.equal(restored.imageLayers[1].kind, 'text');
    assert.equal(restored.imageLayers[1].text, 'Studio project');
  });
});
