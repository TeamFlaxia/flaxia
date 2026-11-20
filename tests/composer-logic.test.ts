import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPollData,
  canSubmit,
  charMeter,
  fileExtension,
  isGameFile,
  MAX_MEDIA_FILE_BYTES,
  parseComposerAutosave,
  parseComposerDrafts,
  validateSubmission,
} from '../src/lib/composer/logic.ts';

describe('composer logic (shared with the Svelte rewrite)', () => {
  describe('parseComposerDrafts', () => {
    it('returns an empty list for anything that is not an array', () => {
      assert.deepEqual(parseComposerDrafts(null), []);
      assert.deepEqual(parseComposerDrafts({}), []);
      assert.deepEqual(parseComposerDrafts('nope'), []);
    });

    it('keeps only well-formed drafts', () => {
      const drafts = parseComposerDrafts([
        { id: 'a', text: 'hello', savedAt: 1 },
        { id: 'b', text: 'bad timestamp', savedAt: Number.NaN },
        { id: 3, text: 'bad id', savedAt: 1 },
        null,
        'junk',
      ]);
      assert.deepEqual(drafts, [{ id: 'a', text: 'hello', savedAt: 1 }]);
    });
  });

  describe('parseComposerAutosave', () => {
    it('rejects malformed values', () => {
      assert.equal(parseComposerAutosave(null), null);
      assert.equal(parseComposerAutosave({ text: 1, savedAt: 2 }), null);
      assert.equal(parseComposerAutosave({ text: 'x', savedAt: Number.POSITIVE_INFINITY }), null);
      assert.equal(
        parseComposerAutosave({ text: 'x', savedAt: 1, poll: { question: 'q', options: 'no', duration: '1d' } }),
        null,
      );
    });

    it('accepts a plain autosave and one with a valid poll', () => {
      assert.deepEqual(parseComposerAutosave({ text: 'x', savedAt: 1 }), { text: 'x', savedAt: 1 });
      const withPoll = {
        text: 'x',
        savedAt: 1,
        poll: { question: 'q', options: ['a', 'b'], duration: '86400000' },
      };
      assert.deepEqual(parseComposerAutosave(withPoll), withPoll);
    });
  });

  describe('file helpers', () => {
    it('normalises extensions to lowercase', () => {
      assert.equal(fileExtension('PHOTO.PNG'), 'png');
      assert.equal(fileExtension('noext'), 'noext');
    });

    it('recognises executable game files', () => {
      assert.equal(isGameFile('level.ZIP'), true);
      assert.equal(isGameFile('game.swf'), true);
      assert.equal(isGameFile('picture.png'), false);
    });
  });

  describe('charMeter', () => {
    it('tracks the conic-gradient ratio and meter states', () => {
      assert.deepEqual(charMeter(0), { ratio: 0, state: 'idle', empty: true });
      assert.equal(charMeter(181).state, 'warn');
      assert.equal(charMeter(199).state, 'warn');
      assert.deepEqual(charMeter(200), { ratio: 1, state: 'max', empty: false });
      assert.equal(charMeter(250).ratio, 1, 'ratio is clamped at 1');
      assert.equal(charMeter(-5).ratio, 0, 'ratio is clamped at 0');
    });
  });

  describe('canSubmit', () => {
    it('requires text or a quoted post and rejects while submitting', () => {
      assert.equal(canSubmit('', null, false), false);
      assert.equal(canSubmit('   ', null, false), false);
      assert.equal(canSubmit('   ', { id: 'q' }, false), true);
      assert.equal(canSubmit('hello', null, false), true);
      assert.equal(canSubmit('hello', null, true), false);
    });
  });

  describe('buildPollData', () => {
    it('returns null when the poll is off or incomplete', () => {
      assert.equal(buildPollData({ active: false, question: 'q', options: ['a', 'b'], durationMs: 1 }), null);
      assert.equal(buildPollData({ active: true, question: '', options: ['a', 'b'], durationMs: 1 }), null);
      assert.equal(buildPollData({ active: true, question: 'q', options: ['a', ''], durationMs: 1 }), null);
    });

    it('trims fields and computes endsAt from the duration', () => {
      const poll = buildPollData({
        active: true,
        question: '  Best?  ',
        options: [' a ', '  ', ' b '],
        durationMs: 1000,
        now: 0,
      });
      assert.deepEqual(poll, {
        question: 'Best?',
        options: ['a', 'b'],
        multipleChoice: false,
        endsAt: new Date(1000).toISOString(),
      });
    });
  });

  describe('validateSubmission', () => {
    const within = { size: 1024 };
    const tooBig = { size: MAX_MEDIA_FILE_BYTES + 1 };

    it('passes a normal submission', () => {
      assert.equal(
        validateSubmission({ selectedFile: null, selectedMedia: [within, within], maxMediaAttachments: 4 }),
        null,
      );
    });

    it('rejects an oversized primary file first', () => {
      assert.deepEqual(validateSubmission({ selectedFile: tooBig, selectedMedia: [], maxMediaAttachments: 4 }), {
        key: 'composer.error_file_too_large',
      });
    });

    it('enforces the plan-dependent media count', () => {
      assert.deepEqual(
        validateSubmission({ selectedFile: null, selectedMedia: [within, within, within], maxMediaAttachments: 2 }),
        { key: 'composer.error_too_many_media', max: 2 },
      );
    });

    it('rejects an oversized media item', () => {
      assert.deepEqual(
        validateSubmission({ selectedFile: null, selectedMedia: [within, tooBig], maxMediaAttachments: 4 }),
        { key: 'composer.error_file_too_large' },
      );
    });

    it('rejects a total over the cap', () => {
      const large = { size: MAX_MEDIA_FILE_BYTES - 1 };
      assert.deepEqual(
        validateSubmission({ selectedFile: null, selectedMedia: [large, large, large], maxMediaAttachments: 10 }),
        { key: 'composer.error_total_too_large', max: 50 },
      );
    });
  });
});
