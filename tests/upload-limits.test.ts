import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { uploadFileBody } from '../src/lib/upload.ts';

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

  it('chunks a file just over 25MB instead of sending one whole-file PUT', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const partSizes: number[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      partSizes.push((init?.body as Blob | undefined)?.size ?? 0);
      return new Response(null, { status: 200 });
    };
    try {
      const file = new File([new Uint8Array(SINGLE_REQUEST_UPLOAD_MAX_BYTES + 1)], 'game.zip', {
        type: 'application/zip',
      });
      assert.equal(await uploadFileBody(file, 'https://example.test/api/upload/zip/x'), true);
      assert.equal(urls.length, 3, 'two parts plus one finalize request');
      assert.match(urls[0], /part=1&parts=2/);
      assert.match(urls[1], /part=2&parts=2/);
      assert.match(urls[2], /finalize=1/);
      assert.equal(partSizes[0], UPLOAD_CHUNK_BYTES);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the chunked uploader for game version updates', () => {
    const modal = readFileSync(new URL('../src/lib/svelte/GameUpdateModal.svelte', import.meta.url), 'utf8');
    assert.match(modal, /uploadFileBody\(/, 'the version modal must not send the whole ZIP in one PUT');
    assert.doesNotMatch(modal, /body: selectedFile/);
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
