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
