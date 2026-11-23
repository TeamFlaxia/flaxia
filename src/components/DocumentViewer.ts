// Legacy-compatible bridge: the document card UI is owned by
// DocumentViewer.svelte. This module keeps the sandbox message bridge, byte
// delivery and download fallbacks for every existing caller.
import { type Component, mount, unmount } from 'svelte';
import { isParentMessage, isSandboxMessage } from '../lib/bridge.js';
import { mediaFileName } from '../lib/media/attachments.ts';
import { nativeApiHref } from '../lib/native-api.js';
import DocumentViewerView from '../lib/svelte/media/DocumentViewer.svelte';

export interface DocumentViewerProps {
  /** R2 key of a `document` attachment (docs/{postId}/{position}.pdf). */
  r2Key: string;
  /** Direct URL override, used when previewing an unsaved file. */
  src?: string;
}

/** R2 key → the public PDF proxy URL. */
export function documentUrl(r2Key: string): string {
  return nativeApiHref(`/api/documents/${r2Key}`);
}

/** How long to wait for the viewer frame to announce itself before giving up. */
const READY_TIMEOUT_MS = 10_000;

interface DocumentViewerInstance {
  openViewer: () => void;
  closeViewer: () => void;
  failViewer: () => void;
  showError: () => void;
}

export interface DocumentViewerHandle {
  destroy: () => void;
}

/**
 * Renders a PDF attachment as a card that either previews it inline or opens
 * it in a new tab.
 *
 * The inline preview frames the pdf.js viewer on the sandbox origin
 * (`{SANDBOX_ORIGIN}/pdf/viewer`, see `src/lib/pdf-viewer-page.ts`). The frame
 * is only mounted on click, so a text-only timeline never downloads a PDF or
 * pdf.js. Bytes travel over the typed bridge: the frame posts DOCUMENT_READY,
 * this side fetches `/api/documents/*` same-origin and transfers the
 * ArrayBuffer as DOCUMENT_DATA.
 */
export function attachDocumentViewer(host: HTMLElement, props: DocumentViewerProps): DocumentViewerHandle {
  const url = props.src || documentUrl(props.r2Key);
  const sandboxOrigin = new URL(import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app').origin;

  let frame: HTMLIFrameElement | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const instance = mount(DocumentViewerView as Component, {
    target: host,
    props: {
      url,
      sandboxOrigin,
      onFrame: (next: HTMLIFrameElement | null) => handleFrame(next),
    },
  }) as unknown as DocumentViewerInstance;

  function onMessage(event: MessageEvent): void {
    if (!frame || event.source !== frame.contentWindow) return;
    // The frame URL is sandbox-origin, but a navigation inside the frame
    // (or a failed load landing on an error page) would change who listens:
    // only accept control messages from the expected origin.
    if (event.origin !== sandboxOrigin) return;
    if (!isParentMessage(event.data)) return;
    switch (event.data.type) {
      case 'DOCUMENT_READY':
        void deliverBytes(event.data.requestId);
        break;
      case 'VIEWER_DOWNLOAD':
        void downloadDocument();
        break;
      case 'VIEWER_CLOSE':
        instance.closeViewer();
        break;
      default:
        // Every other bridge message belongs to game/capture listeners.
        break;
    }
  }

  function handleFrame(next: HTMLIFrameElement | null): void {
    if (next === frame) return;
    teardownFrame();
    frame = next;
    if (!frame) return;
    window.addEventListener('message', onMessage);
    // The frame posts DOCUMENT_READY as soon as its module script runs; a
    // missing route (sandbox Worker not deployed yet) never answers.
    readyTimer = setTimeout(() => instance.failViewer(), READY_TIMEOUT_MS);
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
      // Validate through the shared bridge, then transfer rather than copy.
      const message = { type: 'DOCUMENT_DATA' as const, requestId, bytes };
      if (!isSandboxMessage(message)) throw new Error('Invalid PDF viewer message');
      // Target the sandbox origin explicitly; a wildcard could disclose PDF bytes after navigation.
      const target = frame?.contentWindow;
      target?.postMessage(message, sandboxOrigin, [bytes]);
    } catch (err) {
      console.error('PDF delivery failed:', err);
      instance.failViewer();
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
      anchor.download = mediaFileName(url);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch (err) {
      // Non-fatal: the preview keeps working, the note explains the miss.
      console.error('PDF download failed:', err);
      instance.showError();
    }
  }

  function teardownFrame(): void {
    window.removeEventListener('message', onMessage);
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    frame = null;
  }

  return {
    destroy() {
      teardownFrame();
      unmount(instance as never);
    },
  };
}

export function createDocumentViewer(props: DocumentViewerProps): HTMLElement {
  const container = document.createElement('div');
  const handle = attachDocumentViewer(container, props);
  const observer = new MutationObserver(() => {
    if (container.isConnected) return;
    observer.disconnect();
    handle.destroy();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return container;
}
