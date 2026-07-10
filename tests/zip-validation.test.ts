import assert from 'node:assert';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { validateZipLegacy } from '../src/lib/zip-executor.ts';

async function createZip(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') {
      zip.file(path, content);
    } else {
      zip.file(path, content);
    }
  }
  return zip.generateAsync({ type: 'arraybuffer' }) as Promise<ArrayBuffer>;
}

describe('validateZipLegacy', () => {
  it('accepts a valid zip with index.html at root', async () => {
    const zipData = await createZip({ 'index.html': '<html></html>' });
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });

  it('accepts a valid zip with multiple allowed files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'style.css': 'body { color: red; }',
      'script.js': 'console.log("hello");',
      'image.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });

  it('rejects zip without index.html', async () => {
    const zipData = await createZip({ 'other.html': '<html></html>' });
    await assert.rejects(() => validateZipLegacy(zipData), /index.html not found in zip/);
  });

  it('accepts zip when index.html is in a subdirectory instead of root', async () => {
    const zipData = await createZip({ 'subdir/index.html': '<html></html>' });
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });

  it('rejects zip with too many files (> 255)', async () => {
    const files: Record<string, string> = { 'index.html': '<html></html>' };
    for (let i = 0; i < 256; i++) {
      files[`file${i}.txt`] = 'content';
    }
    const zipData = await createZip(files);
    await assert.rejects(() => validateZipLegacy(zipData), /Too many files/);
  });

  it('accepts zip with exactly 255 files', async () => {
    const files: Record<string, string> = { 'index.html': '<html></html>' };
    for (let i = 0; i < 254; i++) {
      files[`file${i}.txt`] = 'content';
    }
    const zipData = await createZip(files);
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });

  it('rejects zip with a path longer than 255 characters', async () => {
    const longPath = 'a'.repeat(256) + '.html';
    const files: Record<string, string> = {
      'index.html': '<html></html>',
    };
    files[longPath] = 'content';
    const zipData = await createZip(files);
    await assert.rejects(() => validateZipLegacy(zipData), /Path too long/);
  });

  it('rejects zip with directory depth > 10', async () => {
    const files: Record<string, string> = {
      'index.html': '<html></html>',
      'a/b/c/d/e/f/g/h/i/j/k/file.txt': 'content',
    };
    const zipData = await createZip(files);
    await assert.rejects(() => validateZipLegacy(zipData), /Directory too deep/);
  });

  it('accepts zip with directory depth of exactly 10', async () => {
    const files: Record<string, string> = {
      'index.html': '<html></html>',
      'a/b/c/d/e/f/g/h/i/j/file.txt': 'content',
    };
    const zipData = await createZip(files);
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });

  it('rejects zip containing nested .zip files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'archive.zip': 'fake zip content',
    });
    await assert.rejects(() => validateZipLegacy(zipData), /Nested ZIP files are not allowed/);
  });

  it('rejects zip with absolute paths', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      '/etc/passwd': 'malicious',
    });
    await assert.rejects(() => validateZipLegacy(zipData), /Absolute paths are not allowed/);
  });

  it('rejects zip with disallowed file types', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'script.php': 'malicious',
    });
    await assert.rejects(() => validateZipLegacy(zipData), /File type not allowed/);
  });

  it('rejects zip with .sh files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'evil.sh': 'rm -rf /',
    });
    await assert.rejects(() => validateZipLegacy(zipData), /File type not allowed/);
  });

  it('rejects zip with .py files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'script.py': 'print("hello")',
    });
    await assert.rejects(() => validateZipLegacy(zipData), /File type not allowed/);
  });

  it('accepts zip with DOS executable files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'game.exe': new Uint8Array([0x4d, 0x5a, 0x90]),
      'setup.bat': '@echo off',
      'config.conf': 'setting=1',
    });
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });

  it('accepts zip with directories alongside valid files', async () => {
    const zip = new JSZip();
    zip.folder('subdir');
    zip.file('index.html', '<html></html>');
    const zipData = (await zip.generateAsync({ type: 'arraybuffer' })) as ArrayBuffer;
    await assert.doesNotReject(() => validateZipLegacy(zipData));
  });
});
