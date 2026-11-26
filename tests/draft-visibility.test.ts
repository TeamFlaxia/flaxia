import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeDraftVisibility,
  encodeDraftVisibility,
  normalizeDraftVisibility,
} from '../src/lib/composer/draft-visibility.ts';

const VALID_VISIBILITIES = ['public', 'unlisted', 'private', 'direct'] as const;

/** Mirror the browser flow: encode into localStorage, JSON round-trip, decode. */
function roundTrip(stored: unknown): Record<string, unknown> & { visibility: string } {
  const encoded = encodeDraftVisibility({
    id: 'draft-1',
    text: 'draft body',
    savedAt: 1234,
    visibility: stored,
  });
  const json = JSON.parse(JSON.stringify(encoded)) as unknown;
  return decodeDraftVisibility(json);
}

describe('draft visibility codec', () => {
  it('round-trips every supported visibility through JSON storage', () => {
    for (const visibility of VALID_VISIBILITIES) {
      const decoded = roundTrip(visibility);
      assert.equal(decoded.visibility, visibility, `visibility ${visibility} must survive a save/restore`);
      assert.equal(decoded.id, 'draft-1');
      assert.equal(decoded.text, 'draft body');
      assert.equal(decoded.savedAt, 1234);
    }
  });

  it('fails closed to public for unknown or wrong-typed values', () => {
    const invalid: unknown[] = ['everyone', 'PRIVATE', 'private ', 'direct\n', '', 0, 1, true, null, undefined, {}, []];
    for (const value of invalid) {
      assert.equal(normalizeDraftVisibility(value), 'public', `normalize rejects ${JSON.stringify(value)}`);
      assert.equal(
        roundTrip(value).visibility,
        'public',
        `stored draft with visibility ${JSON.stringify(value)} must restore as public`,
      );
    }
  });

  it('defaults legacy drafts and autosave payloads without visibility to public', () => {
    const legacyDraft = JSON.parse(
      JSON.stringify({ id: 'legacy-1', text: 'written before visibility', savedAt: 42 }),
    ) as unknown;
    const restoredDraft = decodeDraftVisibility(legacyDraft);
    assert.equal(restoredDraft.visibility, 'public');
    assert.equal(restoredDraft.id, 'legacy-1');
    assert.equal(restoredDraft.text, 'written before visibility');

    const legacyAutosave = { text: 'autosaved text', poll: { question: 'q?', options: ['a', 'b'], duration: '1' } };
    const restoredAutosave = decodeDraftVisibility(JSON.parse(JSON.stringify(legacyAutosave)) as unknown);
    assert.equal(restoredAutosave.visibility, 'public');
    assert.deepEqual(restoredAutosave.poll, legacyAutosave.poll);
  });

  it('never throws on malformed stored data', () => {
    for (const raw of [null, undefined, 42, 'public', [], true]) {
      assert.equal(decodeDraftVisibility(raw).visibility, 'public');
    }
  });
});
