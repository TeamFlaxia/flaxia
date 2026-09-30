import { isParentMessage } from '../lib/bridge.js';
import { getLocale, t } from '../lib/i18n.js';

export interface DocumentViewerProps {
  /** R2 key of a `document` attachment (docs/{postId}/{position}.pdf). */
  r2Key: string;
  /** Direct URL override, used when previewing an unsaved file. */
  src?: string;
}

/** R2 key → the public PDF proxy URL. */
export function documentUrl(r2Key: string): string {
  return `/api/documents/${r2Key}`;
}

/** How long to wait for the viewer frame to announce itself before giving up. */
const READY_TIMEOUT_MS = 10_000;

/**
 * Renders a PDF attachment as a card that either previews it inline or opens
 * it in a new tab.
 *
 * The inline preview frames the pdf.js viewer on the sandbox origin
 * (`{SANDBOX_ORIGIN}/pdf/viewer`, see `src/lib/pdf-viewer-page.ts`). It is
 * never the browser's built-in plugin: the HTML spec sets the sandboxed
 * plugins browsing context flag on every sandboxed frame with no token to
 * unset it, while browsers render PDFs through that plugin path
 * (whatwg/html#6946), so an embedded plugin document is blocked or blank.
 * pdf.js needs neither plugins nor the main origin — the frame is sandboxed
 * with scripts only, so even a parser bug would land in an opaque origin
 * with no DOM, cookie or storage access here.
 *
 * Bytes travel over the typed bridge (`src/lib/bridge.ts`): the frame posts
 * DOCUMENT_READY, this side fetches `/api/documents/*` same-origin and
 * transfers the ArrayBuffer as DOCUMENT_DATA. The frame is only mounted on
 * click, so a text-only timeline never downloads a PDF or pdf.js.
 */
export function createDocumentViewer(props: DocumentViewerProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'document-viewer';

  const url = props.src || documentUrl(props.r2Key);

  // ---- card: preview button + new-tab link (shown when no frame is open)
  const card = document.createElement('div');
  card.className = 'document-viewer-card';

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'document-viewer-placeholder';
  previewBtn.setAttribute('aria-label', t('document_viewer.open'));

  const icon = document.createElement('span');
  icon.className = 'document-viewer-icon';
  icon.textContent = '📄';

  const label = document.createElement('span');
  label.className = 'document-viewer-label';
  label.textContent = t('document_viewer.open');

  const hint = document.createElement('span');
  hint.className = 'document-viewer-hint';
  hint.textContent = t('document_viewer.hint');

  previewBtn.appendChild(icon);
  previewBtn.appendChild(label);
  previewBtn.appendChild(hint);
  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openViewer();
  });

  const openLink = document.createElement('a');
  openLink.className = 'document-viewer-open-link';
  openLink.href = url;
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = t('document_viewer.open_new_tab');
  openLink.addEventListener('click', (e) => e.stopPropagation());

  card.appendChild(previewBtn);
  card.appendChild(openLink);

  // ---- inline preview frame (hidden until requested)
  const frameWrap = document.createElement('div');
  frameWrap.className = 'document-viewer-frame-wrap';
  frameWrap.style.display = 'none';

  // ---- failure note (route missing, fetch failed, …)
  const errorNote = document.createElement('div');
  errorNote.className = 'document-viewer-error';
  errorNote.textContent = t('document_viewer.error');
  errorNote.style.display = 'none';

  container.appendChild(card);
  container.appendChild(errorNote);
  container.appendChild(frameWrap);

  let frame: HTMLIFrameElement | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  function onMessage(event: MessageEvent): void {
    if (!frame || event.source !== frame.contentWindow) return;
    if (!isParentMessage(event.data)) return;
    switch (event.data.type) {
      case 'DOCUMENT_READY':
        void deliverBytes(event.data.requestId);
        break;
      case 'VIEWER_DOWNLOAD':
        void downloadDocument();
        break;
      case 'VIEWER_CLOSE':
        closeViewer();
        break;
      default:
        // Every other bridge message belongs to game/capture listeners.
        break;
    }
  }

  async function deliverBytes(requestId: string): Promise<void> {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`document fetch failed with ${res.status}`);
      const bytes = await res.arrayBuffer();
      // Transferred, not copied: the viewer takes ownership of the buffer.
      frame?.contentWindow?.postMessage({ type: 'DOCUMENT_DATA', requestId, bytes }, '*', [bytes]);
    } catch (err) {
      console.error('PDF delivery failed:', err);
      failViewer();
    }
  }

  async function downloadDocument(): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`document fetch failed with ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = downloadName();
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch (err) {
      // Non-fatal: the preview keeps working, the note explains the miss.
      console.error('PDF download failed:', err);
      errorNote.style.display = '';
    }
  }

  /** The original filename is not stored in R2 — derive one from the key. */
  function downloadName(): string {
    const parts = url.split('?')[0].split('/');
    const base = parts[parts.length - 1] || 'document.pdf';
    const postId = parts[parts.length - 2] || '';
    return postId ? `${postId}-${base}` : base;
  }

  function openViewer(): void {
    errorNote.style.display = 'none';
    card.style.display = 'none';
    frameWrap.style.display = '';

    frame = document.createElement('iframe');
    frame.className = 'document-viewer-frame';
    frame.setAttribute('title', t('document_viewer.title'));
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // Scripts only: the viewer runs in an opaque origin (allow-same-origin is
    // banned project-wide), and without allow-popups / allow-top-navigation
    // it cannot escape the frame either.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = `${import.meta.env.VITE_SANDBOX_ORIGIN}/pdf/viewer?lang=${getLocale()}`;
    frameWrap.appendChild(frame);

    window.addEventListener('message', onMessage);
    // The frame posts DOCUMENT_READY as soon as its module script runs; a
    // missing route (sandbox Worker not deployed yet) never answers.
    readyTimer = setTimeout(() => failViewer(), READY_TIMEOUT_MS);
  }

  function closeViewer(): void {
    teardownFrame();
    card.style.display = '';
    frameWrap.style.display = 'none';
  }

  function failViewer(): void {
    teardownFrame();
    card.style.display = '';
    frameWrap.style.display = 'none';
    errorNote.style.display = '';
  }

  function teardownFrame(): void {
    window.removeEventListener('message', onMessage);
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    frameWrap.textContent = '';
    frame = null;
  }

  return container;
}
