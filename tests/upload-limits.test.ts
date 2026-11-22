import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FREE_MEDIA_TOTAL_BYTES,
  FREE_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_CHUNKS,
  maxMediaTotalBytesForUser,
  maxUploadBytesForUser,
  PLUS_MEDIA_TOTAL_BYTES,
  PLUS_UPLOAD_MAX_BYTES,
  requiresChunkedUpload,
  SINGLE_REQUEST_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
} from '../shared/upload-limits.ts';
import { validateSubmission } from '../src/lib/composer/logic.ts';

const MIB = 1024 * 1024;

describe('upload limits', () => {
  it('gives Flaxia+ the 128MB ceiling and keeps free at 25MB', () => {
    assert.equal(maxUploadBytesForUser(null), 25 * MIB);
    assert.equal(maxUploadBytesForUser({ badge_type: null }), 25 * MIB);
    assert.equal(maxUploadBytesForUser({ badge_type: 'flaxia_plus' }), 128 * MIB);
    assert.equal(maxUploadBytesForUser({ badge_type: 'flaxia_plus_plus' }), 128 * MIB);
  });

  it('raises the attachment total with the per-file ceiling', () => {
    assert.equal(maxMediaTotalBytesForUser({ badge_type: 'flaxia_plus' }), 256 * MIB);
    assert.equal(maxMediaTotalBytesForUser(null), 50 * MIB);
    assert.ok(PLUS_MEDIA_TOTAL_BYTES > PLUS_UPLOAD_MAX_BYTES);
    assert.ok(PLUS_UPLOAD_MAX_BYTES > FREE_UPLOAD_MAX_BYTES);
  });

  it('splits anything above the single-request ceiling into 16MB parts', () => {
    assert.equal(requiresChunkedUpload(SINGLE_REQUEST_UPLOAD_MAX_BYTES), false);
    assert.equal(requiresChunkedUpload(SINGLE_REQUEST_UPLOAD_MAX_BYTES + 1), true);
    assert.equal(Math.ceil(PLUS_UPLOAD_MAX_BYTES / UPLOAD_CHUNK_BYTES), MAX_UPLOAD_CHUNKS);
    assert.ok(MAX_UPLOAD_CHUNKS <= 8, 'part count must stay small enough for one assembly request');
  });

  it('keeps single requests below Cloudflare’s 100MB body limit', () => {
    assert.ok(SINGLE_REQUEST_UPLOAD_MAX_BYTES < 100 * MIB);
    assert.equal(FREE_MEDIA_TOTAL_BYTES, 50 * MIB);
  });
});

describe('validateSubmission with plan caps', () => {
  const mb = (value: number) => ({ size: value * MIB });

  it('rejects a 100MB file for free accounts', () => {
    const issue = validateSubmission({
      selectedFile: null,
      selectedMedia: [mb(100)],
      maxMediaAttachments: 4,
      maxFileBytes: FREE_UPLOAD_MAX_BYTES,
      maxTotalBytes: FREE_MEDIA_TOTAL_BYTES,
    });
    assert.deepEqual(issue, { key: 'composer.error_file_too_large' });
  });

  it('accepts a 100MB file for Flaxia+ accounts', () => {
    const issue = validateSubmission({
      selectedFile: null,
      selectedMedia: [mb(100)],
      maxMediaAttachments: 32,
      maxFileBytes: PLUS_UPLOAD_MAX_BYTES,
      maxTotalBytes: PLUS_MEDIA_TOTAL_BYTES,
    });
    assert.equal(issue, null);
  });

  it('rejects a 128MB game payload only above the ceiling', () => {
    const atLimit = validateSubmission({
      selectedFile: { size: 128 * MIB },
      selectedMedia: [],
      maxMediaAttachments: 32,
      maxFileBytes: PLUS_UPLOAD_MAX_BYTES,
      maxTotalBytes: PLUS_MEDIA_TOTAL_BYTES,
    });
    assert.equal(atLimit, null);
    const overLimit = validateSubmission({
      selectedFile: { size: 128 * MIB + 1 },
      selectedMedia: [],
      maxMediaAttachments: 32,
      maxFileBytes: PLUS_UPLOAD_MAX_BYTES,
      maxTotalBytes: PLUS_MEDIA_TOTAL_BYTES,
    });
    assert.deepEqual(overLimit, { key: 'composer.error_file_too_large' });
  });

  it('reports the plan total in MB', () => {
    const issue = validateSubmission({
      selectedFile: null,
      selectedMedia: [mb(128), mb(128), mb(1)],
      maxMediaAttachments: 32,
      maxFileBytes: PLUS_UPLOAD_MAX_BYTES,
      maxTotalBytes: PLUS_MEDIA_TOTAL_BYTES,
    });
    assert.deepEqual(issue, { key: 'composer.error_total_too_large', max: 256 });
  });
});
