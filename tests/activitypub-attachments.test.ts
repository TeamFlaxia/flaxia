// Inbound ActivityPub attachments: media stays inline, archives become links.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRemoteAttachments, remoteAttachmentKind } from '../functions/lib/activitypub/attachments.ts';

describe('remoteAttachmentKind', () => {
  it('classifies by media type first', () => {
    assert.equal(remoteAttachmentKind('image/png', '/media/a'), 'image');
    assert.equal(remoteAttachmentKind('video/mp4', '/media/a'), 'video');
    assert.equal(remoteAttachmentKind('audio/mpeg', '/media/a'), 'audio');
  });

  it('falls back to the extension', () => {
    assert.equal(remoteAttachmentKind('', '/media/a.webp'), 'image');
    assert.equal(remoteAttachmentKind('', '/media/a.m4a'), 'audio');
    assert.equal(remoteAttachmentKind('', '/media/a.webm'), 'video');
  });

  it('never treats game archives as playable media', () => {
    assert.equal(remoteAttachmentKind('application/zip', '/games/a.zip'), 'document');
    assert.equal(remoteAttachmentKind('text/html', '/games/a.html'), 'document');
    assert.equal(remoteAttachmentKind('application/x-shockwave-flash', '/games/a.swf'), 'document');
  });
});

describe('parseRemoteAttachments', () => {
  it('keeps absolute http(s) URLs and drops everything else', () => {
    const out = parseRemoteAttachments({
      attachment: [
        { type: 'Document', mediaType: 'image/png', url: 'https://cdn.example/a.png' },
        { type: 'Document', mediaType: 'video/mp4', url: { href: 'https://cdn.example/b.mp4' } },
        { type: 'Document', mediaType: 'application/zip', url: 'https://cdn.example/game.zip' },
        { type: 'Document', mediaType: 'image/png', url: 'javascript:alert(1)' },
        { type: 'Document', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        { type: 'Document', mediaType: 'image/png', url: 'https://cdn.example/a.png' },
        null,
        'nope',
      ],
    });
    assert.deepEqual(out, [
      { url: 'https://cdn.example/a.png', kind: 'image' },
      { url: 'https://cdn.example/b.mp4', kind: 'video' },
      { url: 'https://cdn.example/game.zip', kind: 'document' },
    ]);
  });

  it('caps a hostile attachment list', () => {
    const attachment = Array.from({ length: 100 }, (_, i) => ({
      mediaType: 'image/png',
      url: `https://cdn.example/${i}.png`,
    }));
    assert.equal(parseRemoteAttachments({ attachment }).length, 32);
  });

  it('handles a missing list', () => {
    assert.deepEqual(parseRemoteAttachments({}), []);
  });
});

import { loadNoteAttachments } from '../functions/lib/activitypub/note.ts';

function fakeDb(rows: Array<{ r2_key: string; kind: string }>) {
  return {
    prepare() {
      return {
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      };
    },
  };
}

describe('loadNoteAttachments', () => {
  it('builds absolute media URLs and media types from post_attachments', async () => {
    const out = await loadNoteAttachments(
      fakeDb([
        { r2_key: 'gif/p1/1.png', kind: 'image' },
        { r2_key: 'audio/p1/2.mp3', kind: 'audio' },
        { r2_key: 'video/p1/3.mp4', kind: 'video' },
      ]),
      'p1',
      'https://flaxia.app',
    );
    assert.deepEqual(out, [
      { type: 'Image', mediaType: 'image/png', url: 'https://flaxia.app/api/images/gif/p1/1.png', name: '1.png' },
      { type: 'Audio', mediaType: 'audio/mpeg', url: 'https://flaxia.app/api/audio/audio/p1/2.mp3', name: '2.mp3' },
      { type: 'Video', mediaType: 'video/mp4', url: 'https://flaxia.app/api/video/video/p1/3.mp4', name: '3.mp4' },
    ]);
  });

  it('keeps an already-absolute remote URL untouched', async () => {
    const out = await loadNoteAttachments(
      fakeDb([{ r2_key: 'https://cdn.example/a.webp', kind: 'image' }]),
      'p1',
      'https://flaxia.app',
    );
    assert.equal(out[0]?.url, 'https://cdn.example/a.webp');
  });

  it('federates a game as a link instead of an executable archive', async () => {
    const out = await loadNoteAttachments(fakeDb([]), 'p1', 'https://flaxia.app', {
      payload_key: 'payload/p1/game.zip',
    });
    assert.deepEqual(out, [
      {
        type: 'Link',
        mediaType: 'text/html',
        href: 'https://flaxia.app/arcade/p1',
        url: 'https://flaxia.app/arcade/p1',
        name: 'Play on Flaxia',
      },
    ]);
  });

  it('federates an SWF game as a single arcade link', async () => {
    const out = await loadNoteAttachments(fakeDb([]), 'p1', 'https://flaxia.app', {
      swf_key: 'swf/p1/g.swf',
    });
    assert.deepEqual(out, [
      {
        type: 'Link',
        mediaType: 'text/html',
        href: 'https://flaxia.app/arcade/p1',
        url: 'https://flaxia.app/arcade/p1',
        name: 'Play on Flaxia',
      },
    ]);
  });

  it('keeps media rows first and appends the arcade link for a game with media', async () => {
    const out = await loadNoteAttachments(
      fakeDb([{ r2_key: 'gif/p1/1.png', kind: 'image' }]),
      'p1',
      'https://flaxia.app',
      { payload_key: 'payload/p1/game.zip' },
    );
    assert.deepEqual(out, [
      {
        type: 'Image',
        mediaType: 'image/png',
        url: 'https://flaxia.app/api/images/gif/p1/1.png',
        name: '1.png',
      },
      {
        type: 'Link',
        mediaType: 'text/html',
        href: 'https://flaxia.app/arcade/p1',
        url: 'https://flaxia.app/arcade/p1',
        name: 'Play on Flaxia',
      },
    ]);
  });

  it('falls back to the legacy gif_key when no attachment rows exist', async () => {
    const out = await loadNoteAttachments(fakeDb([]), 'p1', 'https://flaxia.app', {
      gif_key: 'audio/p1/voice.mp3',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, 'Audio');
    assert.equal(out[0]?.url, 'https://flaxia.app/api/audio/audio/p1/voice.mp3');
  });
});
