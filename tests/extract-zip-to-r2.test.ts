import assert from 'node:assert';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { extractZipToR2 } from '../src/lib/wvfs-zip-server.ts';

class MockR2Bucket {
  store = new Map<string, Uint8Array>();
  subrequests = 0;

  async head(key: string): Promise<{ size: number } | null> {
    this.subrequests++;
    const value = this.store.get(key);
    return value ? { size: value.length } : null;
  }

  async get(
    key: string,
    opts?: { range?: { offset: number; length: number } },
  ): Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> } | null> {
    this.subrequests++;
    const value = this.store.get(key);
    if (!value) return null;
    let bytes = value;
    if (opts?.range) {
      const { offset, length } = opts.range;
      bytes = value.slice(offset, offset + length);
    }
    const copy = new Uint8Array(bytes);
    return {
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(copy),
    };
  }

  async put(key: string, body: Uint8Array | string | ArrayBuffer): Promise<void> {
    this.subrequests++;
    if (typeof body === 'string') {
      this.store.set(key, new TextEncoder().encode(body));
    } else if (body instanceof Uint8Array) {
      this.store.set(key, new Uint8Array(body));
    } else {
      this.store.set(key, new Uint8Array(body));
    }
  }
}

async function createZipFileCount(count: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('index.html', '<html></html>');
  for (let i = 1; i < count; i++) {
    zip.file(`asset${i}.txt`, `content${i}`);
  }
  const data = (await zip.generateAsync({ type: 'arraybuffer' })) as ArrayBuffer;
  return new Uint8Array(data);
}

describe('extractZipToR2 (subrequest budget + resume)', () => {
  it('extracts at most maxFiles per invocation and resumes via manifest', async () => {
    const bucket = new MockR2Bucket();
    bucket.store.set('zip/game.zip', await createZipFileCount(12));
    const manifestKey = 'wvfs/post1/.wvfs-manifest';

    const first = await extractZipToR2(bucket as unknown as R2Bucket, 'zip/game.zip', 'post1', null, 5);
    assert.strictEqual(first, 5);
    let manifest = JSON.parse(await (await bucket.get(manifestKey))!.text()) as { files: string[] };
    assert.strictEqual(manifest.files.length, 5);
    assert.ok(bucket.subrequests <= 50, `first call used ${bucket.subrequests} subrequests`);

    bucket.subrequests = 0;
    const second = await extractZipToR2(bucket as unknown as R2Bucket, 'zip/game.zip', 'post1', null, 5);
    assert.strictEqual(second, 5);
    manifest = JSON.parse(await (await bucket.get(manifestKey))!.text()) as { files: string[] };
    assert.strictEqual(manifest.files.length, 10);
    assert.ok(bucket.subrequests <= 50, `second call used ${bucket.subrequests} subrequests`);

    bucket.subrequests = 0;
    const third = await extractZipToR2(bucket as unknown as R2Bucket, 'zip/game.zip', 'post1', null, 5);
    assert.strictEqual(third, 2);
    manifest = JSON.parse(await (await bucket.get(manifestKey))!.text()) as { files: string[] };
    assert.strictEqual(manifest.files.length, 12);
    assert.ok(bucket.subrequests <= 50, `third call used ${bucket.subrequests} subrequests`);
  });

  it('extracts nothing when the archive is already fully persisted', async () => {
    const bucket = new MockR2Bucket();
    bucket.store.set('zip/game.zip', await createZipFileCount(3));

    await extractZipToR2(bucket as unknown as R2Bucket, 'zip/game.zip', 'post2', null, 5);
    bucket.subrequests = 0;
    const result = await extractZipToR2(bucket as unknown as R2Bucket, 'zip/game.zip', 'post2', null, 5);
    assert.strictEqual(result, 0);
    assert.ok(bucket.subrequests <= 50, `idle call used ${bucket.subrequests} subrequests`);
  });

  it('returns 0 when the zip does not exist', async () => {
    const bucket = new MockR2Bucket();
    const result = await extractZipToR2(bucket as unknown as R2Bucket, 'zip/missing.zip', 'post3', null, 5);
    assert.strictEqual(result, 0);
  });
});
