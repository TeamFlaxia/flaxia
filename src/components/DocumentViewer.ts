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
 * Renders a PDF attachment as a card that opens the document in a new tab.
 *
 * There is deliberately no inline `<iframe>`. `allow-same-origin` is banned on
 * every frame in this project, so an embedded viewer would have to run fully
 * sandboxed — and the HTML spec sets the sandboxed plugins browsing context
 * flag on every sandboxed frame with no token to unset it, while browsers
 * render PDFs through that plugin path (whatwg/html#6946: sandboxed frames are
 * "never allowed to display plugins... in the modern world, just means PDFs").
 * A sandboxed frame therefore shows a blocked or blank document, not the PDF.
 * Top-level navigation is unaffected by that rule, so the browser's built-in
 * viewer still works from a plain link.
 *
 * The card is an `<a>`: nothing is fetched until it is activated, so a
 * text-only timeline never downloads a PDF.
 */
export function createDocumentViewer(props: DocumentViewerProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'document-viewer';

  const url = props.src || documentUrl(props.r2Key);

  const openLink = document.createElement('a');
  openLink.className = 'document-viewer-placeholder';
  openLink.href = url;
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.setAttribute('aria-label', t('document_viewer.open'));
  openLink.title = t('document_viewer.open_new_tab');

  const icon = document.createElement('span');
  icon.className = 'document-viewer-icon';
  icon.textContent = '📄';

  const label = document.createElement('span');
  label.className = 'document-viewer-label';
  label.textContent = t('document_viewer.open');

  const hint = document.createElement('span');
  hint.className = 'document-viewer-hint';
  hint.textContent = t('document_viewer.hint');

  openLink.appendChild(icon);
  openLink.appendChild(label);
  openLink.appendChild(hint);

  // The card sits inside the post's click targets; following the link must not
  // also navigate the SPA.
  openLink.addEventListener('click', (e) => e.stopPropagation());

  container.appendChild(openLink);

  return container;
}
