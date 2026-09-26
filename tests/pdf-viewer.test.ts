import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isParentMessage, isSandboxMessage } from '../src/lib/bridge.ts';
import { PDF_VIEWER_HTML, pdfViewerAssetBody, pdfViewerAssetHeaders } from '../src/lib/pdf-viewer-page.ts';

describe('pdf viewer assets (/pdf/*)', () => {
  it('serves the three known assets with the right content types', () => {
    assert.deepEqual(pdfViewerAssetHeaders('viewer'), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    for (const asset of ['pdfjs.mjs', 'pdf.worker.mjs']) {
      const headers = pdfViewerAssetHeaders(asset);
      assert.ok(headers, `${asset} must be servable`);
      assert.match(headers['Content-Type'], /javascript/);
    }
    assert.equal(pdfViewerAssetHeaders('anything-else'), null);
    assert.equal(pdfViewerAssetBody('anything-else'), null);
  });

  it('keeps the viewer page self-contained and plugin-free', () => {
    const html = pdfViewerAssetBody('viewer');
    assert.equal(html, PDF_VIEWER_HTML);
    // The page must drive the typed bridge rather than embed content in the
    // frame src, and must import pdf.js only once bytes actually arrive.
    assert.match(html, /DOCUMENT_READY/);
    assert.match(html, /DOCUMENT_DATA/);
    assert.match(html, /VIEWER_DOWNLOAD/);
    assert.match(html, /VIEWER_CLOSE/);
    assert.match(html, /import\('\/pdf\/pdfjs\.mjs'\)/);
    assert.match(html, /workerSrc = '\/pdf\/pdf\.worker\.mjs'/);
    // Never hand the browser plugin a document — a sandboxed frame cannot
    // host it (whatwg/html#6946) and pdf.js needs a canvas instead.
    assert.doesNotMatch(html, /object|embed/);
    assert.doesNotMatch(html, /allow-same-origin/);
  });

  it('embeds pdf.js with its license header intact', () => {
    const main = pdfViewerAssetBody('pdfjs.mjs');
    const worker = pdfViewerAssetBody('pdf.worker.mjs');
    assert.ok(main && worker);
    assert.ok(main.length > 100_000, 'main bundle must be embedded');
    assert.ok(worker.length > 500_000, 'worker bundle must be embedded');
    // Apache-2.0 attribution must survive the embedding step.
    assert.match(main, /@licstart/);
    assert.match(main, /Apache License, Version 2\.0/);
    assert.match(main, /GlobalWorkerOptions/);
    assert.match(main, /getDocument/);
    // The embed must be the *legacy* build: it carries core-js polyfills for
    // the newer platform APIs pdf.js uses (Uint8Array#toHex, Map upsert), so
    // the viewer does not break on browsers that predate them. The modern
    // build's main bundle has no toHex reference at all.
    assert.match(main, /toHex/);
    assert.match(main, /getOrInsertComputed/);
  });
});

describe('pdf viewer bridge messages', () => {
  it('accepts DOCUMENT_READY / VIEWER_CLOSE / VIEWER_DOWNLOAD with a requestId', () => {
    for (const type of ['DOCUMENT_READY', 'VIEWER_CLOSE', 'VIEWER_DOWNLOAD']) {
      assert.ok(isParentMessage({ type, requestId: 'abc' }), `${type} must be accepted`);
      assert.ok(!isParentMessage({ type }), `${type} without requestId must be rejected`);
      assert.ok(!isParentMessage({ type, requestId: 7 }), `${type} with non-string id must be rejected`);
    }
  });

  it('accepts DOCUMENT_DATA only with a requestId and real bytes', () => {
    assert.ok(isSandboxMessage({ type: 'DOCUMENT_DATA', requestId: 'abc', bytes: new ArrayBuffer(8) }));
    assert.ok(!isSandboxMessage({ type: 'DOCUMENT_DATA', requestId: 'abc' }));
    assert.ok(!isSandboxMessage({ type: 'DOCUMENT_DATA', requestId: 'abc', bytes: 'not-a-buffer' }));
    assert.ok(!isSandboxMessage({ type: 'DOCUMENT_DATA', bytes: new ArrayBuffer(8) }));
  });

  it('keeps the existing message shapes untouched', () => {
    assert.ok(isParentMessage({ type: 'REQUEST_FULLSCREEN' }));
    assert.ok(isSandboxMessage({ type: 'CAPTURE_FRAME', requestId: 'r1' }));
    assert.ok(!isParentMessage({ type: 'DOCUMENT_DATA', requestId: 'abc', bytes: new ArrayBuffer(1) }));
    assert.ok(!isSandboxMessage({ type: 'DOCUMENT_READY', requestId: 'abc' }));
  });
});
