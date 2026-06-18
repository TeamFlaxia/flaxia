import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ALLOWED_EXTENSIONS, getMimeType, isExtensionAllowed, validateFileType } from '../src/lib/file-extensions.ts';

describe('ALLOWED_EXTENSIONS map', () => {
  it('includes web content extensions', () => {
    assert.equal(ALLOWED_EXTENSIONS['.html'], 'text/html');
    assert.equal(ALLOWED_EXTENSIONS['.css'], 'text/css');
    assert.equal(ALLOWED_EXTENSIONS['.js'], 'text/javascript');
    assert.equal(ALLOWED_EXTENSIONS['.json'], 'application/json');
  });

  it('includes image extensions', () => {
    assert.equal(ALLOWED_EXTENSIONS['.png'], 'image/png');
    assert.equal(ALLOWED_EXTENSIONS['.jpg'], 'image/jpeg');
    assert.equal(ALLOWED_EXTENSIONS['.gif'], 'image/gif');
    assert.equal(ALLOWED_EXTENSIONS['.webp'], 'image/webp');
    assert.equal(ALLOWED_EXTENSIONS['.svg'], 'image/svg+xml');
  });

  it('includes font extensions', () => {
    assert.equal(ALLOWED_EXTENSIONS['.woff'], 'font/woff');
    assert.equal(ALLOWED_EXTENSIONS['.woff2'], 'font/woff2');
    assert.equal(ALLOWED_EXTENSIONS['.ttf'], 'font/ttf');
  });

  it('includes audio extensions', () => {
    assert.equal(ALLOWED_EXTENSIONS['.mp3'], 'audio/mpeg');
    assert.equal(ALLOWED_EXTENSIONS['.wav'], 'audio/wav');
    assert.equal(ALLOWED_EXTENSIONS['.ogg'], 'audio/ogg');
  });

  it('includes video extensions', () => {
    assert.equal(ALLOWED_EXTENSIONS['.mp4'], 'video/mp4');
    assert.equal(ALLOWED_EXTENSIONS['.webm'], 'video/webm');
    assert.equal(ALLOWED_EXTENSIONS['.mov'], 'video/quicktime');
  });

  it('includes DOS/support extensions', () => {
    assert.equal(ALLOWED_EXTENSIONS['.exe'], 'application/x-msdos-program');
    assert.equal(ALLOWED_EXTENSIONS['.com'], 'application/x-msdos-program');
    assert.equal(ALLOWED_EXTENSIONS['.bat'], 'text/plain');
    assert.equal(ALLOWED_EXTENSIONS['.zip'], 'application/zip');
    assert.equal(ALLOWED_EXTENSIONS['.jsdos'], 'application/zip');
  });
});

describe('isExtensionAllowed', () => {
  it('returns true for .html files', () => {
    assert.ok(isExtensionAllowed('index.html'));
  });

  it('returns true for .css files', () => {
    assert.ok(isExtensionAllowed('style.css'));
  });

  it('returns true for .js files', () => {
    assert.ok(isExtensionAllowed('script.js'));
  });

  it('returns true for all image file types', () => {
    assert.ok(isExtensionAllowed('image.png'));
    assert.ok(isExtensionAllowed('image.jpg'));
    assert.ok(isExtensionAllowed('image.jpeg'));
    assert.ok(isExtensionAllowed('image.gif'));
    assert.ok(isExtensionAllowed('image.webp'));
    assert.ok(isExtensionAllowed('image.svg'));
    assert.ok(isExtensionAllowed('favicon.ico'));
  });

  it('returns true for font file types', () => {
    assert.ok(isExtensionAllowed('font.woff'));
    assert.ok(isExtensionAllowed('font.woff2'));
    assert.ok(isExtensionAllowed('font.ttf'));
  });

  it('returns true for audio file types', () => {
    assert.ok(isExtensionAllowed('audio.mp3'));
    assert.ok(isExtensionAllowed('audio.wav'));
    assert.ok(isExtensionAllowed('audio.ogg'));
    assert.ok(isExtensionAllowed('audio.m4a'));
    assert.ok(isExtensionAllowed('audio.opus'));
  });

  it('returns true for video file types', () => {
    assert.ok(isExtensionAllowed('video.mp4'));
    assert.ok(isExtensionAllowed('video.webm'));
    assert.ok(isExtensionAllowed('video.mov'));
  });

  it('returns true for WebAssembly and binary files', () => {
    assert.ok(isExtensionAllowed('module.wasm'));
    assert.ok(isExtensionAllowed('data.data'));
    assert.ok(isExtensionAllowed('game.unityweb'));
  });

  it('returns true for DOS/executable files', () => {
    assert.ok(isExtensionAllowed('game.exe'));
    assert.ok(isExtensionAllowed('command.com'));
    assert.ok(isExtensionAllowed('setup.bat'));
    assert.ok(isExtensionAllowed('disk.img'));
    assert.ok(isExtensionAllowed('cd.iso'));
  });

  it('returns false for .php files', () => {
    assert.ok(!isExtensionAllowed('script.php'));
  });

  it('returns false for .py files', () => {
    assert.ok(!isExtensionAllowed('script.py'));
  });

  it('returns false for .rb files', () => {
    assert.ok(!isExtensionAllowed('script.rb'));
  });

  it('returns false for .sh files', () => {
    assert.ok(!isExtensionAllowed('script.sh'));
  });

  it('returns false for .pl files', () => {
    assert.ok(!isExtensionAllowed('script.pl'));
  });

  it('returns false for .dll files', () => {
    assert.ok(!isExtensionAllowed('library.dll'));
  });

  it('returns false for .so files', () => {
    assert.ok(!isExtensionAllowed('library.so'));
  });

  it('returns false for .dmg files', () => {
    assert.ok(!isExtensionAllowed('disk.dmg'));
  });

  it('handles uppercase extensions case-insensitively', () => {
    assert.ok(isExtensionAllowed('INDEX.HTML'));
    assert.ok(isExtensionAllowed('Style.CSS'));
    assert.ok(isExtensionAllowed('Image.PNG'));
    assert.ok(isExtensionAllowed('Script.JS'));
    assert.ok(isExtensionAllowed('Audio.MP3'));
    assert.ok(isExtensionAllowed('Video.MP4'));
  });

  it('handles mixed-case extensions case-insensitively', () => {
    assert.ok(isExtensionAllowed('index.HtMl'));
    assert.ok(isExtensionAllowed('image.PnG'));
    assert.ok(isExtensionAllowed('audio.Mp3'));
  });

  it('returns false for files without extension', () => {
    assert.ok(!isExtensionAllowed('README'));
    assert.ok(!isExtensionAllowed('Makefile'));
  });

  it('returns false for files with only a dot at the end', () => {
    assert.ok(!isExtensionAllowed('file.'));
  });

  it('handles dotted filenames like .htaccess', () => {
    assert.ok(!isExtensionAllowed('.htaccess'));
  });

  it('handles paths with directories', () => {
    assert.ok(isExtensionAllowed('subdir/style.css'));
    assert.ok(isExtensionAllowed('a/b/c/script.js'));
    assert.ok(isExtensionAllowed('./image.png'));
  });
});

describe('getMimeType', () => {
  it('returns correct MIME type for .html', () => {
    assert.equal(getMimeType('index.html'), 'text/html');
  });

  it('returns correct MIME type for .css', () => {
    assert.equal(getMimeType('style.css'), 'text/css');
  });

  it('returns correct MIME type for .png', () => {
    assert.equal(getMimeType('image.png'), 'image/png');
  });

  it('returns correct MIME type for .jpg', () => {
    assert.equal(getMimeType('photo.jpg'), 'image/jpeg');
  });

  it('returns correct MIME type for .mp3', () => {
    assert.equal(getMimeType('audio.mp3'), 'audio/mpeg');
  });

  it('returns correct MIME type for .mp4', () => {
    assert.equal(getMimeType('video.mp4'), 'video/mp4');
  });

  it('returns text/plain for unknown extensions', () => {
    assert.equal(getMimeType('file.xyz'), 'text/plain');
    assert.equal(getMimeType('file.php'), 'text/plain');
  });

  it('returns text/plain for files without extension', () => {
    assert.equal(getMimeType('README'), 'text/plain');
  });

  it('handles uppercase extensions case-insensitively', () => {
    assert.equal(getMimeType('index.HTML'), 'text/html');
    assert.equal(getMimeType('image.PNG'), 'image/png');
  });

  it('handles path with directory prefix', () => {
    assert.equal(getMimeType('assets/images/photo.jpg'), 'image/jpeg');
  });
});

describe('validateFileType', () => {
  it('returns allowed=true and correct MIME for known files', () => {
    const result = validateFileType('index.html');
    assert.ok(result.allowed);
    assert.equal(result.mimeType, 'text/html');
  });

  it('returns allowed=false and text/plain for unknown files', () => {
    const result = validateFileType('script.php');
    assert.ok(!result.allowed);
    assert.equal(result.mimeType, 'text/plain');
  });

  it('returns allowed=true for .exe DOS programs', () => {
    const result = validateFileType('game.exe');
    assert.ok(result.allowed);
    assert.equal(result.mimeType, 'application/x-msdos-program');
  });

  it('returns allowed=false for files without extension', () => {
    const result = validateFileType('README');
    assert.ok(!result.allowed);
    assert.equal(result.mimeType, 'text/plain');
  });

  it('is case-insensitive for allowed check', () => {
    assert.ok(validateFileType('INDEX.HTML').allowed);
    assert.ok(validateFileType('IMAGE.PNG').allowed);
    assert.ok(!validateFileType('SCRIPT.PHP').allowed);
  });
});
