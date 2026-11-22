import assert from 'node:assert';
import { describe, it } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { BlobObject, BlobStore } from '../functions/lib/ports/index.ts';
import { zipStructureHash } from '../functions/lib/scan/zip-list.ts';
import { readZipStructureHash } from '../functions/lib/scan/zip-range.ts';

function rangeStore(bytes: Uint8Array): BlobStore {
  const meta = (size: number) => ({
    key: 'archive.zip',
    size,
    etag: 'etag',
    httpEtag: '"etag"',
    uploaded: new Date(0),
  });
  return {
    head: async () => meta(bytes.length),
    get: async (_key, options) => {
      const offset = options?.range?.offset ?? 0;
      const length = options?.range?.length ?? bytes.length - offset;
      const slice = bytes.slice(offset, offset + length);
      return { ...meta(bytes.length), body: new Response(slice).body } as unknown as BlobObject;
    },
    put: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
  };
}

describe('ZIP structure hash from R2 ranges', () => {
  it('matches the whole-buffer hash', async () => {
    const bytes = zipSync({
      'index.html': strToU8('<html><body>game</body></html>'),
      'assets/main.js': strToU8('console.log("hello")'),
      'assets/logo.png': new Uint8Array(2048),
    });
    const expected = zipStructureHash(bytes);
    assert.ok(expected, 'fixture must parse as a ZIP');
    assert.equal(await readZipStructureHash(rangeStore(bytes), 'archive.zip'), expected);
  });

  it('returns null for a truncated object', async () => {
    const bytes = zipSync({ 'index.html': strToU8('<html></html>') });
    const truncated = bytes.slice(0, bytes.length - 8);
    assert.equal(await readZipStructureHash(rangeStore(truncated), 'archive.zip'), null);
  });

  it('returns null for a non-ZIP payload', async () => {
    const bytes = new TextEncoder().encode('not a zip');
    assert.equal(await readZipStructureHash(rangeStore(bytes), 'archive.zip'), null);
  });
});
