import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportStudioProject, importStudioProject } from '../src/lib/editor/studio-project-store.ts';
import {
  deriveVaultKeBits,
  encryptVaultItem,
  VAULT_KDF_ITERATIONS,
  VAULT_SALT_BYTES,
} from '../src/lib/vault/primitives.ts';

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
        gainEnvelope: {
          start: 1,
          middle: 0.75,
          end: 1.5,
          points: [
            { position: 0, gain: 1 },
            { position: 0.3, gain: 0.25 },
            { position: 1, gain: 1.5 },
          ],
        },
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
      'Weekend short',
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
    assert.deepEqual(restored.audioClips[0].gainEnvelope?.points, [
      { position: 0, gain: 1 },
      { position: 0.3, gain: 0.25 },
      { position: 1, gain: 1.5 },
    ]);
    assert.equal(restored.videoClips[0].fileIndex, 4);
    assert.equal(restored.videoClips[0].fit, 'cover');
    assert.equal(restored.videoClips[0].transitionOut, 1.2);
    assert.equal(restored.videoClips[0].transitionType, 'wipeleft');
    assert.equal(restored.videoClips[0].track, 'main');
    assert.equal(restored.videoClips[1].track, 'overlay');
    assert.equal(restored.videoClips[1].transitionOut, 0);
    assert.equal(restored.videoFormat, 'portrait');
    assert.equal(restored.projectName, 'Weekend short');
    assert.equal(restored.imageLayers[0].fileIndex, 2);
    assert.equal(restored.imageLayers[0].blend, 'screen');
    assert.equal(restored.imageLayers[0].paintLayer, true);
    assert.equal(restored.imageLayers[1].kind, 'text');
    assert.equal(restored.imageLayers[1].text, 'Studio project');
  });

  it('drops imported audio clips with an unsupported track index', async () => {
    const passphrase = 'portable test passphrase';
    const salt = new Uint8Array(VAULT_SALT_BYTES).fill(7);
    const key = await deriveVaultKeBits(passphrase, salt, { alg: 'PBKDF2-SHA256', iterations: VAULT_KDF_ITERATIONS });
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        files: [{ name: 'voice.wav', type: 'audio/wav', lastModified: 1, offset: 0, size: 4 }],
        audioClips: [
          {
            id: 'malicious-track',
            fileIndex: 0,
            track: 1_000_000_000,
            start: 0,
            sourceStart: 0,
            sourceEnd: 1,
            gain: 1,
            muted: false,
          },
        ],
        videoClips: [],
        imageLayers: [],
        videoFormat: 'landscape',
      }),
    );
    const plaintext = new Uint8Array(4 + manifest.length + 4);
    new DataView(plaintext.buffer).setUint32(0, manifest.length);
    plaintext.set(manifest, 4);
    plaintext.set(new Uint8Array([1, 2, 3, 4]), 4 + manifest.length);
    try {
      const encrypted = await encryptVaultItem(key, 'studio_portable_project_v1', plaintext);
      const record = new TextEncoder().encode(JSON.stringify(encrypted));
      const bytes = new Uint8Array(5 + salt.length + record.length);
      bytes.set([0x46, 0x58, 0x53, 0x54, 1]);
      bytes.set(salt, 5);
      bytes.set(record, 5 + salt.length);
      const restored = await importStudioProject(
        new File([bytes], 'malicious.flaxia-studio', { type: 'application/vnd.flaxia.studio-project' }),
        passphrase,
      );
      assert.deepEqual(restored.audioClips, []);
    } finally {
      plaintext.fill(0);
      key.fill(0);
    }
  });
});
