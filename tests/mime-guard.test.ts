import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  checkDeclaredType,
  checkExtensionMatchesMime,
  detectMimeType,
  extensionOf,
} from '../functions/lib/scan/mime.ts';

const encoder = new TextEncoder();

function withHeader(header: number[], length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(header, 0);
  return bytes;
}

describe('detectMimeType', () => {
  it('sniffs the formats the upload allowlist relies on', () => {
    assert.equal(detectMimeType(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(detectMimeType(withHeader([0xff, 0xd8, 0xff])), 'image/jpeg');
    assert.equal(detectMimeType(withHeader([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
    assert.equal(detectMimeType(withHeader([0x50, 0x4b, 0x03, 0x04])), 'application/zip');
    assert.equal(detectMimeType(withHeader([0x46, 0x57, 0x53])), 'application/x-shockwave-flash');
    assert.equal(detectMimeType(withHeader([0x43, 0x57, 0x53])), 'application/x-shockwave-flash');
    assert.equal(detectMimeType(withHeader([0x5a, 0x57, 0x53])), 'application/x-shockwave-flash');
    assert.equal(detectMimeType(withHeader([0x25, 0x50, 0x44, 0x46])), 'application/pdf');
    assert.equal(detectMimeType(withHeader([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm');
    assert.equal(detectMimeType(withHeader([0x49, 0x44, 0x33])), 'audio/mpeg');
  });

  it('sniffs HTML markup so it cannot ride along as another type', () => {
    assert.equal(detectMimeType(encoder.encode('<!DOCTYPE html><html></html>')), 'text/html');
    assert.equal(detectMimeType(encoder.encode('<html lang="en"></html>')), 'text/html');
  });

  it('sniffs WebP through the RIFF container', () => {
    assert.equal(detectMimeType(encoder.encode('RIFF....WEBPVP8 ')), 'image/webp');
  });

  it('returns null for unknown or truncated content', () => {
    assert.equal(detectMimeType(encoder.encode('plain text, no magic bytes')), null);
    assert.equal(detectMimeType(new Uint8Array(0)), null);
    assert.equal(detectMimeType(new Uint8Array([0xff])), null);
  });
});

describe('extensionOf', () => {
  it('reads extensions off keys and filenames', () => {
    assert.equal(extensionOf('images/photo.png'), 'png');
    assert.equal(extensionOf('payload/abc.thumb.gif'), 'gif');
    assert.equal(extensionOf('game.ZIP'), 'zip');
    assert.equal(extensionOf('.hidden'), null);
    assert.equal(extensionOf('avatar/deadbeef'), null, 'content-hash keys carry no extension');
    assert.equal(extensionOf('ad/payload/ad_123'), null, 'extensionless ad payloads');
    assert.equal(extensionOf('trailing.'), null);
  });
});

describe('checkExtensionMatchesMime', () => {
  it('rejects extensions that contradict the magic bytes', () => {
    assert.ok(checkExtensionMatchesMime('malware.png', 'text/html'));
    assert.ok(checkExtensionMatchesMime('game.zip', 'text/html'));
    assert.ok(checkExtensionMatchesMime('icon.gif', 'application/x-shockwave-flash'));
    assert.ok(checkExtensionMatchesMime('payload.thumb.jpg', 'image/png'));
    assert.ok(checkExtensionMatchesMime('doc.pdf', 'application/zip'));
  });

  it('accepts consistent or uninformative names', () => {
    assert.equal(checkExtensionMatchesMime('photo.png', 'image/png'), null);
    assert.equal(checkExtensionMatchesMime('photo.jpg', 'image/jpeg'), null);
    assert.equal(checkExtensionMatchesMime('game.zip', 'application/zip'), null);
    assert.equal(checkExtensionMatchesMime('movie.swf', 'application/x-shockwave-flash'), null);
    assert.equal(checkExtensionMatchesMime('page.html', 'text/html'), null);
    assert.equal(checkExtensionMatchesMime('unknown.xyz', 'text/html'), null, 'unknown ext is not judged');
    assert.equal(checkExtensionMatchesMime('avatar/deadbeef', 'text/html'), null, 'no ext is not judged');
  });
});

describe('checkDeclaredType', () => {
  it('passes through absent and generic declarations', () => {
    assert.equal(checkDeclaredType(undefined, 'image/png'), null);
    assert.equal(checkDeclaredType(null, 'image/png'), null);
    assert.equal(checkDeclaredType('', 'image/png'), null);
    assert.equal(checkDeclaredType('application/octet-stream', 'image/png'), null);
  });

  it('normalizes common aliases', () => {
    assert.equal(checkDeclaredType('image/jpg; charset=binary', 'image/jpeg'), null);
    assert.equal(checkDeclaredType('image/x-png', 'image/png'), null);
    assert.equal(checkDeclaredType('application/x-zip-compressed', 'application/zip'), null);
  });

  it('rejects a declared type that contradicts the bytes', () => {
    assert.ok(checkDeclaredType('image/png', 'text/html'));
    assert.ok(checkDeclaredType('image/gif', 'application/x-shockwave-flash'));
    assert.ok(checkDeclaredType('video/mp4', 'text/html'));
  });

  it('stays relaxed for ZIP payloads uploaded with generic form types', () => {
    assert.equal(checkDeclaredType('text/html', 'application/zip'), null);
  });
});

describe('masquerade scenarios', () => {
  it('catches HTML and SWF payloads disguised as images', () => {
    const html = encoder.encode('<script>alert(1)</script>');
    assert.equal(detectMimeType(html), 'text/html');
    assert.equal(detectMimeType(encoder.encode('\n   <!DOCTYPE html><html></html>')), 'text/html');
    assert.equal(detectMimeType(encoder.encode('\ufeff<html></html>')), 'text/html');
    assert.ok(checkExtensionMatchesMime('avatar.png', 'text/html'));
    assert.ok(checkDeclaredType('image/png', 'text/html'));

    const swf = withHeader([0x46, 0x57, 0x53]);
    assert.equal(detectMimeType(swf), 'application/x-shockwave-flash');
    assert.ok(checkExtensionMatchesMime('sticker.gif', 'application/x-shockwave-flash'));
    assert.ok(checkDeclaredType('image/gif', 'application/x-shockwave-flash'));
  });

  it('catches ZIP payloads disguised as images', () => {
    const zip = withHeader([0x50, 0x4b, 0x03, 0x04]);
    assert.equal(detectMimeType(zip), 'application/zip');
    assert.ok(checkExtensionMatchesMime('thumb.jpg', 'application/zip'));
    // The declared-type check stays relaxed for ZIP content (game uploads
    // carry form/page content types); the key's extension still catches it.
    assert.equal(checkDeclaredType('image/jpeg', 'application/zip'), null);
  });

  it('catches image payloads disguised as ZIP game uploads', () => {
    const png = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(detectMimeType(png), 'image/png');
    assert.ok(checkExtensionMatchesMime('game.zip', 'image/png'));
  });
});
