// Pure logic shared by the migrated Svelte modals. The DOM-free helpers keep
// the dialogs testable without a browser: validation, payloads, endpoints and
// label presentation.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blockedAvatarPath,
  buildCounterNoticePayload,
  buildReportPayload,
  displayShareIcon,
  gameUpdateFileError,
  isCounterNoticeValid,
  isCurrentVersion,
  isReportSubmitEnabled,
  plainReportLabel,
  platformLabelKey,
  REPORT_CATEGORIES,
  removeBlockedUser,
  unblockEndpoint,
  versionsEndpoint,
} from '../src/lib/modals/dialog-logic.ts';
import {
  canSubmitGameUpload,
  extractHashtags,
  fileExtension,
  fileSizeParts,
  gameFileTypeLabel,
  gameUploadFileError,
  thumbnailFileError,
} from '../src/lib/modals/game-upload.ts';

describe('share modal labels', () => {
  it('keeps brand glyphs by type and falls back to the initial for emoji', () => {
    assert.equal(displayShareIcon('𝕏', 'X'), '𝕏');
    assert.equal(displayShareIcon('in', 'LinkedIn'), 'in');
    assert.equal(displayShareIcon('🦋', 'Bluesky'), 'B');
    assert.equal(displayShareIcon('🦋', ''), '');
  });

  it('maps known platforms to locale keys and leaves unknown names alone', () => {
    assert.equal(platformLabelKey('X'), 'share.platform_x');
    assert.equal(platformLabelKey('Bluesky'), 'share.platform_bluesky');
    assert.equal(platformLabelKey('Mastodon'), 'Mastodon');
  });
});

describe('report modal validation', () => {
  it('strips leading cosmetic emoji from transposed labels', () => {
    assert.equal(plainReportLabel('🚩 Report post'), 'Report post');
    assert.equal(plainReportLabel('Report post'), 'Report post');
  });

  it('exposes every category in display order', () => {
    assert.deepEqual(
      REPORT_CATEGORIES.map((category) => category.value),
      [
        'spam',
        'harassment',
        'hate_speech',
        'inappropriate',
        'misinformation',
        'privacy',
        'copyright',
        'malware',
        'csam',
        'nsfw_untagged',
        'other',
      ],
    );
  });

  it('requires a category and, for copyright, a complete DMCA block', () => {
    assert.equal(isReportSubmitEnabled(null), false);
    assert.equal(isReportSubmitEnabled('spam'), true);
    assert.equal(isReportSubmitEnabled('copyright'), false);
    assert.equal(isReportSubmitEnabled('copyright', { work: ' secret ', email: '', sworn: true }), false);
    assert.equal(
      isReportSubmitEnabled('copyright', { work: ' My work ', email: 'a@example.com', sworn: false }),
      false,
    );
    assert.equal(isReportSubmitEnabled('copyright', { work: ' My work ', email: 'a@example.com', sworn: true }), true);
  });

  it('builds the API payload with trimmed DMCA fields only when needed', () => {
    assert.deepEqual(buildReportPayload('p1', 'spam'), { post_id: 'p1', category: 'spam' });
    assert.deepEqual(buildReportPayload('p1', 'copyright', { work: ' work ', email: ' a@b.c ', sworn: true }), {
      post_id: 'p1',
      category: 'copyright',
      dmca: { work_description: 'work', reporter_email: 'a@b.c', sworn: true },
    });
  });
});

describe('counter-notice validation', () => {
  const complete = {
    name: 'A',
    email: 'a@example.com',
    address: '1 Street',
    phone: '123',
    statement: true,
    consent: true,
  };

  it('requires every field and both checkboxes', () => {
    assert.equal(isCounterNoticeValid(complete), true);
    assert.equal(isCounterNoticeValid({ ...complete, name: '   ' }), false);
    assert.equal(isCounterNoticeValid({ ...complete, consent: false }), false);
  });

  it('trims the payload sent to the API', () => {
    assert.deepEqual(buildCounterNoticePayload({ ...complete, name: ' A ', address: ' 1 Street ' }), {
      name: 'A',
      email: 'a@example.com',
      address: '1 Street',
      phone: '123',
      statement: true,
      consent_jurisdiction: true,
    });
  });
});

describe('blocked users helpers', () => {
  it('resolves avatar paths and keeps native-safe defaults', () => {
    assert.equal(blockedAvatarPath('abc'), '/api/images/abc');
    assert.equal(blockedAvatarPath(null), '/api/images/default-avatar');
    assert.equal(blockedAvatarPath(''), '/api/images/default-avatar');
  });

  it('encodes usernames in the block endpoint', () => {
    assert.equal(unblockEndpoint('foo'), '/api/users/foo/block');
    assert.equal(unblockEndpoint('a/b'), '/api/users/a%2Fb/block');
  });

  it('drops an unblocked user from a list', () => {
    const users = [{ username: 'a' }, { username: 'b' }];
    assert.deepEqual(removeBlockedUser(users, 'a'), [{ username: 'b' }]);
    assert.deepEqual(removeBlockedUser(users, 'zzz'), users);
  });
});

describe('version history helpers', () => {
  it('builds the versions endpoint', () => {
    assert.equal(versionsEndpoint('p1'), '/api/posts/p1/versions');
  });

  it('marks the latest (null) and matching version rows', () => {
    assert.equal(isCurrentVersion(null, null), true);
    assert.equal(isCurrentVersion('v1', 'v1'), true);
    assert.equal(isCurrentVersion('v1', 'v2'), false);
    assert.equal(isCurrentVersion(null, 'v1'), false);
  });
});

describe('game update validation', () => {
  it('reports missing and non-zip selections', () => {
    assert.equal(gameUpdateFileError(null), 'missing');
    assert.equal(gameUpdateFileError({ name: 'game.zip' }), null);
    assert.equal(gameUpdateFileError({ name: 'GAME.ZIP' }), null);
    assert.equal(gameUpdateFileError({ name: 'game.html' }), 'not_zip');
  });

  it('enforces the plan-aware byte ceiling', () => {
    assert.equal(gameUpdateFileError({ name: 'game.zip', size: 26 * 1024 * 1024 }, 25 * 1024 * 1024), 'too_large');
    assert.equal(gameUpdateFileError({ name: 'game.zip', size: 26 * 1024 * 1024 }, 128 * 1024 * 1024), null);
  });
});

describe('game upload helpers', () => {
  it('normalises extensions', () => {
    assert.equal(fileExtension('GAME.ZIP'), 'zip');
    assert.equal(fileExtension('noext'), 'noext');
    assert.equal(fileExtension('trailing.'), '');
  });

  it('accepts zip/html/htm uploads up to the plan ceiling', () => {
    assert.equal(gameUploadFileError({ name: 'game.zip', size: 10 }, 100), null);
    assert.equal(gameUploadFileError({ name: 'game.HTML', size: 10 }, 100), null);
    assert.equal(gameUploadFileError({ name: 'game.swf', size: 10 }, 100), 'file_type');
    assert.equal(gameUploadFileError({ name: 'game.zip', size: 101 }, 100), 'file_too_large');
    assert.equal(gameUploadFileError({ name: 'game.zip', size: 100 }, 100), null);
  });

  it('accepts image thumbnails up to 1MB', () => {
    assert.equal(thumbnailFileError({ name: 'a.png', size: 10 }), null);
    assert.equal(thumbnailFileError({ name: 'a.PNG', size: 10 }), null);
    assert.equal(thumbnailFileError({ name: 'a.svg', size: 10 }), 'thumbnail_type');
    assert.equal(thumbnailFileError({ name: 'a.png', size: 1024 * 1024 + 1 }), 'thumbnail_too_large');
  });

  it('formats byte sizes for the i18n file_size keys', () => {
    assert.deepEqual(fileSizeParts(512), { unit: 'bytes', value: '512' });
    assert.deepEqual(fileSizeParts(1536), { unit: 'kb', value: '1.5' });
    assert.deepEqual(fileSizeParts(2.5 * 1024 * 1024), { unit: 'mb', value: '2.5' });
  });

  it('labels zip payloads as HTML5', () => {
    assert.equal(gameFileTypeLabel('game.zip'), ' (HTML5)');
    assert.equal(gameFileTypeLabel('GAME.ZIP'), ' (HTML5)');
    assert.equal(gameFileTypeLabel('page.html'), '');
  });

  it('extracts unique hashtags including Japanese scripts', () => {
    assert.deepEqual(extractHashtags('hello #flaxia #ゲーム #flaxia'), ['flaxia', 'ゲーム']);
    assert.deepEqual(extractHashtags('no tags'), []);
  });

  it('enables submit only with a file and a valid title', () => {
    assert.equal(canSubmitGameUpload({ hasFile: true, title: 'Game', submitting: false }), true);
    assert.equal(canSubmitGameUpload({ hasFile: false, title: 'Game', submitting: false }), false);
    assert.equal(canSubmitGameUpload({ hasFile: true, title: '   ', submitting: false }), false);
    assert.equal(canSubmitGameUpload({ hasFile: true, title: 'x'.repeat(201), submitting: false }), false);
    assert.equal(canSubmitGameUpload({ hasFile: true, title: 'Game', submitting: true }), false);
  });
});
