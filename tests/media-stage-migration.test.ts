// Media/stage migration guardrails: the DOM is owned by Svelte components and
// the legacy modules stay thin adapters. Pure helpers live in src/lib/media/.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { attachmentUrl, isAbsoluteMediaUrl, mediaFileName } from '../src/lib/media/attachments.ts';
import {
  canExecuteStage,
  isZipGame,
  mediaSignature,
  stageBoxRatio,
  stageClassFor,
  stripLeadingEmoji,
} from '../src/lib/media/stage.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('attachmentUrl maps every media kind to its proxy route', () => {
  assert.equal(isAbsoluteMediaUrl('https://cdn.example/a.png'), true);
  assert.equal(isAbsoluteMediaUrl('http://cdn.example/a.png'), true);
  assert.equal(isAbsoluteMediaUrl('images/1/a.png'), false);

  assert.match(
    attachmentUrl({ r2_key: 'images/1/a.png', kind: 'image', position: 0 }),
    /\/api\/images\/images\/1\/a\.png$/,
  );
  assert.match(
    attachmentUrl({ r2_key: 'audio/1/a.mp3', kind: 'audio', position: 0 }),
    /\/api\/audio\/audio\/1\/a\.mp3$/,
  );
  assert.match(
    attachmentUrl({ r2_key: 'video/1/a.mp4', kind: 'video', position: 0 }),
    /\/api\/video\/video\/1\/a\.mp4$/,
  );
  assert.match(
    attachmentUrl({ r2_key: 'docs/1/a.pdf', kind: 'document', position: 0 }),
    /\/api\/documents\/docs\/1\/a\.pdf$/,
  );
  assert.equal(
    attachmentUrl({ r2_key: 'https://cdn.example/a.pdf', kind: 'document', position: 0 }),
    'https://cdn.example/a.pdf',
  );
});

test('mediaFileName derives a stable download name', () => {
  assert.equal(mediaFileName('docs/abc/0.pdf'), 'abc-0.pdf');
  assert.equal(mediaFileName('docs/abc/0.pdf?token=1'), 'abc-0.pdf');
  assert.equal(mediaFileName('plain.pdf'), 'plain.pdf');
});

test('stage classification covers zip, flash, audio, video and images', () => {
  assert.equal(isZipGame('zip/1.zip'), true);
  assert.equal(isZipGame('payload/1/index.html'), true);
  assert.equal(isZipGame('versions/1/index.html'), true);
  assert.equal(isZipGame('images/1/a.png'), false);
  assert.equal(isZipGame(null), false);

  assert.equal(stageClassFor({ id: '1', payload_key: 'zip/1.zip' } as never), 'post-stage--zip');
  assert.equal(stageClassFor({ id: '1', swf_key: 'swf/1.swf' } as never), 'post-stage--flash');
  assert.equal(stageClassFor({ id: '1', gif_key: 'audio/1/a.mp3' } as never), 'post-stage--audio');
  assert.equal(stageClassFor({ id: '1', gif_key: 'video/1/a.mp4' } as never), 'post-stage--video');
  assert.equal(stageClassFor({ id: '1', gif_key: 'images/1/a.png' } as never), 'post-stage--image');
  assert.equal(stageClassFor({ id: '1', thumbnail_key: 'thumbs/1.jpg' } as never), 'post-stage--image-thumb');
  assert.equal(stageClassFor({ id: '1' } as never), null);

  assert.equal(stageBoxRatio({ id: '1', payload_key: 'zip/1.zip' } as never), '16 / 9');
  assert.equal(stageBoxRatio({ id: '1', swf_key: 'swf/1.swf' } as never), '4 / 3');
  assert.equal(stageBoxRatio({ id: '1', gif_key: 'images/1/a.png' } as never), null);

  assert.equal(canExecuteStage({ id: '1', payload_key: 'zip/1.zip' } as never), true);
  assert.equal(canExecuteStage({ id: '1', swf_key: 'swf/1.swf' } as never), true);
  assert.equal(canExecuteStage({ id: '1', gif_key: 'images/1/a.png' } as never), false);
});

test('mediaSignature changes when any media key changes', () => {
  const base = { id: '1', gif_key: 'images/1/a.png' } as never;
  assert.equal(mediaSignature(base), mediaSignature({ ...(base as object), id: '2' } as never));
  assert.notEqual(mediaSignature(base), mediaSignature({ id: '1', gif_key: 'images/1/b.png' } as never));
  assert.match(
    mediaSignature({ id: '1', attachments: [{ kind: 'image', r2_key: 'images/1/a.png', position: 0 }] } as never),
    /image:images\/1\/a\.png/,
  );
});

test('stripLeadingEmoji keeps the translated label readable', () => {
  assert.equal(stripLeadingEmoji('▶ Run'), 'Run');
  assert.equal(stripLeadingEmoji('⏳<span>Loading...</span>'), '<span>Loading...</span>');
  assert.equal(stripLeadingEmoji('Plain'), 'Plain');
});

test('PostStage is a Svelte bridge with the legacy DOM builders removed', async () => {
  const bridge = await read('src/components/PostStage.ts');
  assert.match(bridge, /mount\(PostStageView/);
  assert.doesNotMatch(bridge, /createExecutionButton|createThumbnailWithOverlay|createSwfExecutionButton/);

  const component = await read('src/lib/svelte/media/PostStage.svelte');
  assert.match(component, /post-stage-layer--preview/);
  assert.match(component, /post-stage-layer--execution/);
  assert.match(component, /zip-execution-button|StageLaunchButton/);
  assert.match(component, /stage-hint/);

  const thumbnail = await read('src/lib/svelte/media/StageThumbnail.svelte');
  assert.match(thumbnail, /thumbnail-overlay-container/);
  assert.match(thumbnail, /stage-play-overlay/);
});

test('media components own their markup in Svelte', async () => {
  const carousel = await read('src/lib/svelte/media/MediaCarousel.svelte');
  assert.match(carousel, /media-carousel-track/);
  assert.match(carousel, /media-carousel-dots/);

  const cues = await read('src/lib/svelte/media/MediaCues.svelte');
  assert.match(cues, /media-cues/);
  assert.match(cues, /media-cue--/);

  const documentViewer = await read('src/lib/svelte/media/DocumentViewer.svelte');
  assert.match(documentViewer, /document-viewer-placeholder/);
  assert.match(documentViewer, /document-viewer-frame/);

  const flash = await read('src/lib/svelte/media/FlashPlayer.svelte');
  assert.match(flash, /flash-loading/);
  assert.match(flash, /flash-fullscreen-btn/);

  const imageLightbox = await read('src/lib/svelte/media/ImageLightbox.svelte');
  assert.match(imageLightbox, /fx-lightbox__zoom/);
  assert.match(imageLightbox, /fx-lightbox__nav/);
});

test('legacy adapters mount Svelte instead of building DOM', async () => {
  const flash = await read('src/components/FlashPlayer.ts');
  assert.match(flash, /mount\(FlashPlayerView/);
  assert.doesNotMatch(flash, /createFlashLoadingIndicator/);

  const documentViewer = await read('src/components/DocumentViewer.ts');
  assert.match(documentViewer, /mount\(DocumentViewerView/);
  assert.doesNotMatch(documentViewer, /document\.createElement\('button'\)/);

  const cues = await read('src/components/MediaCues.ts');
  assert.match(cues, /mount\(MediaCuesView/);
  assert.doesNotMatch(cues, /className = 'media-cue/);
});
