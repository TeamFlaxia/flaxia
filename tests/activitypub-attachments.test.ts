// Inbound ActivityPub attachments: media stays inline, archives become links.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseRemoteAttachments,
  remoteAttachmentKind,
  storeRemoteAttachments,
} from '../functions/lib/activitypub/attachments.ts';
import { enrichPostsWithAttachments } from '../functions/lib/attachments.ts';
import { type PostRow, renderPostArticle } from '../functions/lib/render-html.ts';
import { attachmentUrl } from '../src/lib/media/attachments.ts';
import { createTestDatabase } from './helpers/d1.ts';

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

  it('accepts AP Image/Video/Audio types with href URLs and type arrays', () => {
    assert.deepEqual(
      parseRemoteAttachments({
        attachment: [
          { type: ['Image'], url: { href: 'https://cdn.example/a.webp' } },
          { type: 'Video', url: { href: 'https://cdn.example/b.mp4' } },
          { type: 'Audio', url: { href: 'https://cdn.example/c.mp3' } },
          { type: 'Document', url: { href: 'https://cdn.example/doc.pdf' } },
        ],
      }),
      [
        { url: 'https://cdn.example/a.webp', kind: 'image' },
        { url: 'https://cdn.example/b.mp4', kind: 'video' },
        { url: 'https://cdn.example/c.mp3', kind: 'audio' },
        { url: 'https://cdn.example/doc.pdf', kind: 'document' },
      ],
    );
  });

  it('reads Mastodon REST media_attachments with lower-case types', () => {
    assert.deepEqual(
      parseRemoteAttachments({
        media_attachments: [
          { type: 'image', url: 'https://cdn.example/a.png' },
          { type: 'gifv', url: 'https://cdn.example/b.mp4' },
          { type: 'audio', remote_url: 'https://cdn.example/c.ogg' },
          { type: 'unknown', url: 'https://cdn.example/game.zip' },
        ],
      }),
      [
        { url: 'https://cdn.example/a.png', kind: 'image' },
        { url: 'https://cdn.example/b.mp4', kind: 'video' },
        { url: 'https://cdn.example/c.ogg', kind: 'audio' },
        { url: 'https://cdn.example/game.zip', kind: 'document' },
      ],
    );
  });

  it('drops credential-bearing URLs', () => {
    assert.deepEqual(parseRemoteAttachments({ attachment: [{ url: 'https://user:pass@cdn.example/a.png' }] }), []);
  });
});

describe('stored remote attachments', () => {
  it('survive the real post_attachments schema with the right kind and position', async () => {
    const db = createTestDatabase();
    try {
      await db
        .prepare(`INSERT INTO posts (id, user_id, username, text, status, created_at)
                  VALUES ('p1', '', 'alice@remote.example', 'hi', 'published', ?)`)
        .bind('2026-01-01T00:00:00.000Z')
        .run();
      await storeRemoteAttachments(db, 'p1', {
        attachment: [
          { type: 'Image', url: { href: 'https://cdn.example/a.png' } },
          { type: 'Document', mediaType: 'application/zip', url: 'https://cdn.example/game.zip' },
        ],
      });
      const rows = await db
        .prepare('SELECT r2_key, kind, position FROM post_attachments WHERE post_id = ? ORDER BY position')
        .bind('p1')
        .all<{ r2_key: string; kind: string; position: number }>();
      assert.deepEqual(
        rows.results.map((row) => ({ ...row })),
        [
          { r2_key: 'https://cdn.example/a.png', kind: 'image', position: 1 },
          { r2_key: 'https://cdn.example/game.zip', kind: 'document', position: 2 },
        ],
      );
    } finally {
      db.close();
    }
  });

  it('are enriched back onto posts as remote audio/document URLs', async () => {
    const db = createTestDatabase();
    try {
      await db
        .prepare(`INSERT INTO posts (id, user_id, username, text, status, created_at)
                  VALUES ('p1', '', 'alice@remote.example', 'hi', 'published', ?)`)
        .bind('2026-01-01T00:00:00.000Z')
        .run();
      await storeRemoteAttachments(db, 'p1', {
        attachment: [
          { type: 'Audio', url: 'http://cdn.example/voice.mp3' },
          { type: 'Document', url: 'https://cdn.example/archive.zip' },
        ],
      });
      const posts: Array<{ id: string; attachments?: unknown }> = [{ id: 'p1' }];
      await enrichPostsWithAttachments(posts, db);
      assert.deepEqual(posts[0]?.attachments, [
        { r2_key: 'http://cdn.example/voice.mp3', kind: 'audio', position: 1 },
        { r2_key: 'https://cdn.example/archive.zip', kind: 'document', position: 2 },
      ]);
      assert.equal(
        attachmentUrl({ r2_key: 'http://cdn.example/voice.mp3', kind: 'audio', position: 1 }),
        'http://cdn.example/voice.mp3',
      );
    } finally {
      db.close();
    }
  });
});

describe('remote media rendering', () => {
  const ssrPost = (attachments: PostRow['attachments']): PostRow => ({
    id: 'p1',
    user_id: '',
    username: 'alice@remote.example',
    display_name: 'Alice',
    avatar_key: null,
    text: 'media post',
    hashtags: '[]',
    gif_key: null,
    payload_key: null,
    swf_key: null,
    thumbnail_key: null,
    attachments,
    fresh_count: 0,
    bookmark_count: 0,
    reply_count: 0,
    impressions: 0,
    parent_id: null,
    root_id: null,
    depth: 0,
    status: 'published',
    hidden: 0,
    created_at: '2026-01-01T00:00:00.000Z',
  });

  it('resolves every kind to a direct URL when the key is absolute', () => {
    assert.equal(
      attachmentUrl({ r2_key: 'https://cdn.example/a.png', kind: 'image', position: 1 }),
      'https://cdn.example/a.png',
    );
    assert.equal(
      attachmentUrl({ r2_key: 'https://cdn.example/v.mp4', kind: 'video', position: 1 }),
      'https://cdn.example/v.mp4',
    );
    assert.equal(
      attachmentUrl({ r2_key: 'https://cdn.example/a.mp3', kind: 'audio', position: 1 }),
      'https://cdn.example/a.mp3',
    );
    assert.equal(
      attachmentUrl({ r2_key: 'https://cdn.example/game.zip', kind: 'document', position: 1 }),
      'https://cdn.example/game.zip',
    );
  });

  it('renders remote images/audio/video inline and documents as links only', () => {
    const html = renderPostArticle(
      ssrPost([
        { r2_key: 'https://cdn.example/a.png', kind: 'image', position: 1 },
        { r2_key: 'https://cdn.example/v.mp4', kind: 'video', position: 2 },
        { r2_key: 'https://cdn.example/a.mp3', kind: 'audio', position: 3 },
        { r2_key: 'https://cdn.example/game.zip', kind: 'document', position: 4 },
      ]),
      'https://flaxia.app',
    );
    assert.match(html, /<img class="ssr-post-attachment" src="https:\/\/cdn\.example\/a\.png"/);
    assert.match(html, /<video class="ssr-post-attachment"[^>]*src="https:\/\/cdn\.example\/v\.mp4"/);
    assert.match(html, /<audio class="ssr-post-attachment"[^>]*src="https:\/\/cdn\.example\/a\.mp3"/);
    assert.match(
      html,
      /<a class="ssr-post-attachment ssr-post-document" href="https:\/\/cdn\.example\/game\.zip"[^>]*>.*game\.zip<\/a>/,
    );
    // A remote archive must never become an executable embed in SSR output.
    assert.doesNotMatch(html, /<iframe|<embed|<object|<script/i);
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
