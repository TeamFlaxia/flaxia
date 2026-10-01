import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStudioPostMode } from '../src/lib/editor/studio-post-plan.ts';

describe('Studio post handoff planning', () => {
  it('posts a rendered video sequence before considering individual project assets', () => {
    assert.equal(
      resolveStudioPostMode({
        hasVideoClips: true,
        selectedIsGame: false,
        hasAudioClips: true,
        hasVisibleImageLayers: true,
        selectedIsPostable: true,
      }),
      'video',
    );
  });

  it('keeps a selected game package separate from ordinary attachments', () => {
    assert.equal(
      resolveStudioPostMode({
        hasVideoClips: false,
        selectedIsGame: true,
        hasAudioClips: false,
        hasVisibleImageLayers: true,
        selectedIsPostable: true,
      }),
      'game',
    );
  });

  it('exports audio and visible image layers as compatible timeline assets', () => {
    assert.equal(
      resolveStudioPostMode({
        hasVideoClips: false,
        selectedIsGame: false,
        hasAudioClips: true,
        hasVisibleImageLayers: true,
        selectedIsPostable: false,
      }),
      'timeline-assets',
    );
    assert.equal(
      resolveStudioPostMode({
        hasVideoClips: false,
        selectedIsGame: false,
        hasAudioClips: false,
        hasVisibleImageLayers: true,
        selectedIsPostable: false,
      }),
      'timeline-assets',
    );
  });

  it('uses only the selected postable asset or rejects an unsupported code tab', () => {
    const base = {
      hasVideoClips: false,
      selectedIsGame: false,
      hasAudioClips: false,
      hasVisibleImageLayers: false,
    };
    assert.equal(resolveStudioPostMode({ ...base, selectedIsPostable: true }), 'selected-file');
    assert.equal(resolveStudioPostMode({ ...base, selectedIsPostable: false }), 'unsupported');
  });
});
