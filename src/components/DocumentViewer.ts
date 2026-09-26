import { t } from '../lib/i18n.js';

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

/**
 * Renders a PDF attachment inside a native viewer.
 *
 * The frame is lazy: the browser PDF plugin is expensive to spin up, so it is
 * only mounted once the viewer is opened. That also keeps a text-only post
 * from loading a PDF engine it will never display.
 *
 * The frame loads a same-origin URL, and the response is served as
 * `application/pdf` with `X-Frame-Options: SAMEORIGIN`, so the browser's
 * built-in viewer renders it. The sandbox (see below) puts the framed document
 * in an opaque origin, so it cannot reach our DOM, cookies or storage. Clicking
 * the overlay must not fall through to the post, hence stopPropagation.
 */
export function createDocumentViewer(props: DocumentViewerProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'document-viewer';

  const url = props.src || documentUrl(props.r2Key);

  const frameWrap = document.createElement('div');
  frameWrap.className = 'document-viewer-frame-wrap';
  frameWrap.style.display = 'none';

  const frame = document.createElement('iframe');
  frame.className = 'document-viewer-frame';
  frame.src = url;
  // Fully sandboxed: no tokens at all. `allow-same-origin` is permanently
  // banned on every iframe in this project (see AGENTS.md), and pairing it with
  // `allow-scripts` would be the classic sandbox escape on a same-origin frame.
  // The native PDF viewer needs none of them — it renders plugin content
  // happily inside an opaque origin, and the response is already restricted to
  // magic-byte-validated PDFs served as application/pdf with nosniff.
  // The iframe's one job is rendering, not interaction, so everything else
  // (top-navigation, popups, forms, storage) stays blocked.
  frame.setAttribute('sandbox', '');
  frame.setAttribute('title', t('document_viewer.title'));
  frameWrap.appendChild(frame);

  const placeholder = document.createElement('button');
  placeholder.type = 'button';
  placeholder.className = 'document-viewer-placeholder';
  placeholder.setAttribute('aria-label', t('document_viewer.open'));

  const icon = document.createElement('span');
  icon.className = 'document-viewer-icon';
  icon.textContent = '📄';

  const label = document.createElement('span');
  label.className = 'document-viewer-label';
  label.textContent = t('document_viewer.open');

  const hint = document.createElement('span');
  hint.className = 'document-viewer-hint';
  hint.textContent = t('document_viewer.hint');

  placeholder.appendChild(icon);
  placeholder.appendChild(label);
  placeholder.appendChild(hint);

  const openLink = document.createElement('a');
  openLink.className = 'document-viewer-open-link';
  openLink.href = url;
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = t('document_viewer.open_new_tab');
  openLink.addEventListener('click', (e) => e.stopPropagation());

  placeholder.addEventListener('click', (e) => {
    // Mount the viewer in place, then hide the placeholder.
    e.stopPropagation();
    frameWrap.style.display = 'block';
    placeholder.style.display = 'none';
  });

  container.appendChild(placeholder);
  container.appendChild(frameWrap);
  container.appendChild(openLink);

  return container;
}
