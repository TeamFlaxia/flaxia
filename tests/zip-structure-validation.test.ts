import assert from 'node:assert';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { validateZipStructure } from '../src/lib/wvfs-zip-server.ts';

async function createZip(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') {
      zip.file(path, content);
    } else {
      zip.file(path, content);
    }
  }
  const data = (await zip.generateAsync({ type: 'arraybuffer' })) as ArrayBuffer;
  return new Uint8Array(data);
}

describe('validateZipStructure', () => {
  it('accepts a valid zip with index.html at root', async () => {
    const zipData = await createZip({ 'index.html': '<html></html>' });
    assert.doesNotThrow(() => validateZipStructure(zipData));
  });

  it('accepts a valid zip with multiple allowed files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'style.css': 'body { color: red; }',
      'script.js': 'console.log("hello");',
      'image.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    assert.doesNotThrow(() => validateZipStructure(zipData));
  });

  it('rejects zip without index.html', async () => {
    const zipData = await createZip({ 'other.html': '<html></html>' });
    assert.throws(() => validateZipStructure(zipData), /index.html not found in zip/);
  });

  it('accepts zip when index.html is in a subdirectory instead of root', async () => {
    const zipData = await createZip({ 'subdir/index.html': '<html></html>' });
    assert.doesNotThrow(() => validateZipStructure(zipData));
  });

  it('rejects zip with too many files (> 255)', async () => {
    const files: Record<string, string> = { 'index.html': '<html></html>' };
    for (let i = 0; i < 256; i++) {
      files[`file${i}.txt`] = 'content';
    }
    const zipData = await createZip(files);
    assert.throws(() => validateZipStructure(zipData), /Too many files/);
  });

  it('accepts zip with exactly 255 files', async () => {
    const files: Record<string, string> = { 'index.html': '<html></html>' };
    for (let i = 0; i < 254; i++) {
      files[`file${i}.txt`] = 'content';
    }
    const zipData = await createZip(files);
    assert.doesNotThrow(() => validateZipStructure(zipData));
  });

  it('rejects zip with a path longer than 255 characters', async () => {
    const longPath = 'a'.repeat(256) + '.html';
    const zipData = await createZip({
      'index.html': '<html></html>',
      [longPath]: 'content',
    });
    assert.throws(() => validateZipStructure(zipData), /Path too long/);
  });

  it('rejects zip with directory depth > 10', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'a/b/c/d/e/f/g/h/i/j/k/file.txt': 'content',
    });
    assert.throws(() => validateZipStructure(zipData), /Directory too deep/);
  });

  it('accepts zip with directory depth of exactly 10', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'a/b/c/d/e/f/g/h/i/j/file.txt': 'content',
    });
    assert.doesNotThrow(() => validateZipStructure(zipData));
  });

  it('rejects zip containing nested .zip files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'archive.zip': 'fake zip content',
    });
    assert.throws(() => validateZipStructure(zipData), /Nested ZIP files are not allowed/);
  });

  it('rejects zip with absolute paths', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      '/etc/passwd': 'malicious',
    });
    assert.throws(() => validateZipStructure(zipData), /Absolute paths are not allowed/);
  });

  it('rejects zip with path traversal', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      '../evil.txt': 'malicious',
    });
    assert.throws(() => validateZipStructure(zipData), /Path traversal detected/);
  });

  it('rejects zip with disallowed file types', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'script.php': 'malicious',
    });
    assert.throws(() => validateZipStructure(zipData), /File type not allowed/);
  });

  it('rejects zip with .sh files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'evil.sh': 'rm -rf /',
    });
    assert.throws(() => validateZipStructure(zipData), /File type not allowed/);
  });

  it('rejects zip with .py files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'script.py': 'print("hello")',
    });
    assert.throws(() => validateZipStructure(zipData), /File type not allowed/);
  });

  it('rejects zip with .exe files', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      'game.exe': new Uint8Array([0x4d, 0x5a, 0x90]),
    });
    assert.throws(() => validateZipStructure(zipData), /File type not allowed/);
  });

  it('accepts zip with directories alongside valid files', async () => {
    const zip = new JSZip();
    zip.folder('subdir');
    zip.file('index.html', '<html></html>');
    const data = (await zip.generateAsync({ type: 'arraybuffer' })) as ArrayBuffer;
    assert.doesNotThrow(() => validateZipStructure(new Uint8Array(data)));
  });

  it('rejects invalid binary data that is not a zip', async () => {
    const garbage = new Uint8Array(1024).fill(0x41);
    assert.throws(() => validateZipStructure(garbage), /Invalid ZIP/);
  });

  it('rejects entry names containing backslashes (#94)', async () => {
    const zipData = await createZip({
      'index.html': '<html></html>',
      '..\\evil.html': '<html></html>',
    });
    assert.throws(() => validateZipStructure(zipData), /Backslash in entry name/);
  });
});
