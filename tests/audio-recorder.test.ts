import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAudioRecordingFile, preferredAudioRecordingMimeType } from '../src/lib/editor/audio-recorder.ts';

describe('Studio microphone recordings', () => {
  it('prefers Opus and falls back to the first supported browser container', () => {
    const supported = new Set(['audio/mp4', 'audio/webm']);
    assert.equal(
      preferredAudioRecordingMimeType((type) => supported.has(type)),
      'audio/mp4',
    );
    assert.equal(
      preferredAudioRecordingMimeType(() => false),
      null,
    );
  });

  it('packages captured chunks with a matching playable extension and timestamp', async () => {
    const file = createAudioRecordingFile(
      [new Blob(['discarded'], { type: 'audio/ogg' }), new Blob(['waveform'])],
      'audio/ogg;codecs=opus',
      1234,
    );
    assert.equal(file.name, 'recording-1234.ogg');
    assert.equal(file.type, 'audio/ogg;codecs=opus');
    assert.equal(file.lastModified, 1234);
    assert.equal(await file.text(), 'discardedwaveform');
  });

  it('uses a chunk MIME type when the recorder leaves it blank', () => {
    const file = createAudioRecordingFile([new Blob(['capture'], { type: 'audio/mp4' })], '', 99);
    assert.equal(file.name, 'recording-99.m4a');
    assert.equal(file.type, 'audio/mp4');
  });

  it('rejects a stop event that produced no audio data', () => {
    assert.throws(() => createAudioRecordingFile([], 'audio/webm'), /No audio was captured/);
  });
});
