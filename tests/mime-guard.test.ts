import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  checkDeclaredType,
  checkExtensionMatchesMime,
  detectMimeType,
  extensionOf,
  isAllowedImageMime,
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

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const png = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(detectMimeType(png.buffer), 'image/png');
    assert.equal(detectMimeType(png), 'image/png');
  });

  it('covers every magic signature the allowlist relies on', () => {
    const cases: Array<[string, number[]]> = [
      ['image/png', [0x89, 0x50, 0x4e, 0x47]],
      ['image/jpeg', [0xff, 0xd8, 0xff]],
      ['image/gif', [0x47, 0x49, 0x46, 0x38]],
      ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
      ['application/zip', [0x50, 0x4b, 0x05, 0x06]],
      ['application/zip', [0x50, 0x4b, 0x07, 0x08]],
      ['application/x-shockwave-flash', [0x43, 0x57, 0x53]],
      ['application/x-shockwave-flash', [0x46, 0x57, 0x53]],
      ['application/x-shockwave-flash', [0x5a, 0x57, 0x53]],
      ['audio/mpeg', [0x49, 0x44, 0x33]],
      ['audio/mpeg', [0xff, 0xfb]],
      ['audio/mpeg', [0xff, 0xf3]],
      ['audio/mpeg', [0xff, 0xf2]],
      ['audio/mpeg', [0xff, 0xe3]],
      ['audio/mpeg', [0xff, 0xe2]],
      ['audio/ogg', [0x4f, 0x67, 0x67, 0x53]],
      ['video/webm', [0x1a, 0x45, 0xdf, 0xa3]],
      ['video/mp4', [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]],
      ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
    ];
    for (const [mime, header] of cases) {
      assert.equal(detectMimeType(withHeader(header)), mime, `header ${header.join(',')}`);
    }
  });

  it('matches WAV at offset 8, inside the RIFF container', () => {
    const wav = withHeader([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    assert.equal(detectMimeType(wav), 'audio/wav');
    // RIFF with a non-WAVE/WEBP tag is not recognized.
    assert.equal(detectMimeType(withHeader([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), null);
  });

  it('tells WebP and WAV apart by their RIFF tag', () => {
    const riff = (tag: string): Uint8Array => {
      const bytes = new Uint8Array(16);
      bytes.set(encoder.encode('RIFF'), 0);
      bytes.set(encoder.encode(tag), 8);
      return bytes;
    };
    assert.equal(detectMimeType(riff('WEBP')), 'image/webp');
    assert.equal(detectMimeType(riff('WAVE')), 'audio/wav');
  });

  it('ignores markup markers deeper in the file', () => {
    const bytes = new Uint8Array(1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
    bytes[100] = 0x3c; // '<' far from the start must not turn it into HTML
    assert.equal(detectMimeType(bytes), 'image/png');
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

  it('lowercases and takes only the last segment', () => {
    assert.equal(extensionOf('PHOTO.PNG'), 'png');
    assert.equal(extensionOf('a.b/file'), null, 'a dot in a directory is not an extension');
    assert.equal(extensionOf('archive.tar.gz'), 'gz');
    assert.equal(extensionOf('file.mp4?token=1'), null, 'query strings make the extension unreadable');
  });

  it('rejects extensions that are too long or not alphanumeric', () => {
    assert.equal(extensionOf('file.abcdefghi'), null, '9 chars');
    assert.equal(extensionOf('file.abc-def'), null, 'hyphen');
    assert.equal(extensionOf('file.abc def'), null, 'space');
  });
});

describe('checkExtensionMatchesMime', () => {
  it('rejects extensions that contradict the magic bytes', () => {
    assert.ok(checkExtensionMatchesMime('malware.png', 'text/html'));
    assert.ok(checkExtensionMatchesMime('game.zip', 'text/html'));
    assert.ok(checkExtensionMatchesMime('icon.gif', 'application/x-shockwave-flash'));
    assert.ok(checkExtensionMatchesMime('song.mp3', 'image/png'));
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

  it('accepts an image whose extension disagrees with its bytes', () => {
    // Common for downloaded files: the bytes are one image format, the name
    // another. Both decode anywhere, so this is not a masquerade.
    assert.equal(checkExtensionMatchesMime('payload.thumb.jpg', 'image/png'), null);
    assert.equal(checkExtensionMatchesMime('photo.png', 'image/webp'), null);
    assert.equal(checkExtensionMatchesMime('sticker.gif', 'image/jpeg'), null);
    // The tolerance stops at the image class.
    assert.ok(checkExtensionMatchesMime('photo.png', 'text/html'));
    assert.ok(checkExtensionMatchesMime('photo.png', 'application/pdf'));
  });

  it('accepts container families the sniffer cannot split', () => {
    // ftyp always sniffs as video/mp4, EBML always as video/webm — the tracks
    // a file actually carries are invisible to the magic bytes.
    assert.equal(checkExtensionMatchesMime('clip.m4a', 'video/mp4'), null, '.m4a sniffs as video/mp4');
    assert.equal(checkExtensionMatchesMime('clip.mov', 'video/mp4'), null, '.mov sniffs as video/mp4');
    assert.equal(checkExtensionMatchesMime('clip.webm', 'video/webm'), null, 'audio .webm sniffs as video/webm');
    assert.ok(checkExtensionMatchesMime('clip.m4a', 'text/html'), 'the family rule does not weaken the check');
    assert.ok(checkExtensionMatchesMime('clip.mov', 'video/webm'), 'ISO-BMFF and EBML stay distinct');
  });

  it('accepts every allowlisted image extension over every allowlisted image', () => {
    const images = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    for (const ext of extensions) {
      for (const detected of images) {
        assert.equal(checkExtensionMatchesMime(`photo.${ext}`, detected), null, `.${ext} over ${detected}`);
      }
    }
  });

  it('is case-insensitive and tolerates uninformative names', () => {
    assert.equal(checkExtensionMatchesMime('GAME.ZIP', 'application/zip'), null);
    assert.equal(checkExtensionMatchesMime('PHOTO.PNG', 'image/png'), null);
    assert.equal(checkExtensionMatchesMime('noextension', 'application/pdf'), null);
    assert.equal(checkExtensionMatchesMime('archive.unknownext', 'application/pdf'), null);
  });
});

describe('isAllowedImageMime', () => {
  it('allows exactly the four image formats the pipeline decodes', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      assert.equal(isAllowedImageMime(mime), true, mime);
    }
    for (const mime of ['image/svg+xml', 'image/bmp', 'image/tiff', 'text/html', 'audio/ogg', null]) {
      assert.equal(isAllowedImageMime(mime), false, String(mime));
    }
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
    assert.ok(checkDeclaredType('audio/mpeg', 'image/png'));
  });

  it('stays relaxed for ZIP payloads uploaded with generic form types', () => {
    assert.equal(checkDeclaredType('text/html', 'application/zip'), null);
  });

  it('accepts the declared types the composer actually sends', () => {
    // PostComposer's allowedTypes ships file.type as-is; these three are all
    // in its accept list and all upload successfully.
    assert.equal(checkDeclaredType('audio/mp4', 'video/mp4'), null, '.m4a declares audio/mp4, sniffs video/mp4');
    assert.equal(checkDeclaredType('video/quicktime', 'video/mp4'), null, '.mov declares video/quicktime');
    assert.equal(checkDeclaredType('audio/webm', 'video/webm'), null, 'recorded .webm declares audio/webm');
  });

  it('accepts the browser spellings for .m4a and .wav', () => {
    assert.equal(checkDeclaredType('audio/x-m4a', 'video/mp4'), null, 'Safari/macOS and Chrome on Windows');
    assert.equal(checkDeclaredType('audio/m4a', 'video/mp4'), null);
    assert.equal(checkDeclaredType('audio/x-wav', 'audio/wav'), null, 'Chrome on Windows');
    assert.equal(checkDeclaredType('audio/wave', 'audio/wav'), null, 'Firefox');
    assert.equal(checkDeclaredType('audio/vnd.wave', 'audio/wav'), null);
    assert.ok(checkDeclaredType('audio/x-m4a', 'text/html'), 'the alias must not cover HTML');
    assert.ok(checkDeclaredType('audio/x-wav', 'application/x-shockwave-flash'), 'nor SWF');
  });

  it('accepts an image declared over another image format', () => {
    // file.type comes from the extension, so a JPEG saved as .png declares
    // image/png over image/jpeg bytes. Both are allowlisted images.
    assert.equal(checkDeclaredType('image/png', 'image/jpeg'), null);
    assert.equal(checkDeclaredType('image/jpeg', 'image/webp'), null);
    assert.equal(checkDeclaredType('image/gif', 'image/png'), null);
    // Only the allowlisted image formats get the tolerance: SVG is an image
    // declaration that must never pass.
    assert.ok(checkDeclaredType('image/svg+xml', 'image/png'));
    assert.ok(checkDeclaredType('image/svg+xml', 'text/html'));
  });

  it('does not extend the container families across container formats', () => {
    assert.ok(checkDeclaredType('audio/mp4', 'video/webm'), 'an MP4 declared over WebM bytes is still a mismatch');
    assert.ok(checkDeclaredType('audio/webm', 'video/mp4'), 'a WebM declared over MP4 bytes is still a mismatch');
    assert.ok(checkDeclaredType('audio/mp4', 'text/html'), 'family tolerance must not cover HTML');
  });

  it('treats every generic binary declaration as uninformative', () => {
    for (const generic of ['application/octet-stream', 'binary/octet-stream', 'application/binary', '', '   ']) {
      assert.equal(checkDeclaredType(generic, 'image/png'), null, generic);
      assert.equal(checkDeclaredType(generic, 'text/html'), null, generic);
    }
  });

  it('normalizes aliases regardless of case, whitespace and parameters', () => {
    assert.equal(checkDeclaredType('IMAGE/JPG; charset=binary', 'image/jpeg'), null);
    assert.equal(checkDeclaredType('  image/x-png  ', 'image/png'), null);
    assert.equal(checkDeclaredType('AUDIO/X-M4A', 'video/mp4'), null);
    assert.equal(checkDeclaredType('Application/X-Zip-Compressed', 'application/zip'), null);
    assert.equal(checkDeclaredType('audio/mp3', 'audio/mpeg'), null);
  });

  it('accepts every allowlisted image declaration over every allowlisted image', () => {
    const images = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    for (const declared of images) {
      for (const detected of images) {
        assert.equal(checkDeclaredType(declared, detected), null, `${declared} over ${detected}`);
      }
    }
  });

  it('rejects every cross-class declaration', () => {
    const images = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    for (const declared of images) {
      for (const detected of ['text/html', 'application/x-shockwave-flash', 'application/pdf', 'audio/mpeg']) {
        assert.ok(checkDeclaredType(declared, detected), `${declared} over ${detected}`);
      }
    }
    for (const detected of images) {
      for (const declared of ['audio/mpeg', 'video/mp4', 'application/pdf', 'text/html']) {
        assert.ok(checkDeclaredType(declared, detected), `${declared} over ${detected}`);
      }
    }
  });

  it('relaxes the declared check for ZIP content only', () => {
    assert.equal(checkDeclaredType('text/html', 'application/zip'), null);
    assert.equal(checkDeclaredType('image/png', 'application/zip'), null);
    // A ZIP declaration over image bytes is not relaxed.
    assert.ok(checkDeclaredType('application/zip', 'image/png'));
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
