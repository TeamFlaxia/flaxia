<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { getLocale, t } from '../../../lib/i18n.ts';

interface Props {
  url: string;
  sandboxOrigin: string;
  /** The viewer frame mounted (or unmounted) its browsing context. */
  onFrame: (frame: HTMLIFrameElement | null) => void;
}

let { url, sandboxOrigin, onFrame }: Props = $props();

let open = $state(false);
let failed = $state(false);
let frame = $state<HTMLIFrameElement | null>(null);
let viewerSrc = $derived(`${sandboxOrigin}/pdf/viewer?lang=${getLocale()}`);

export function openViewer(): void {
  failed = false;
  open = true;
}

export function closeViewer(): void {
  open = false;
  failed = false;
}

export function failViewer(): void {
  open = false;
  failed = true;
}

export function showError(): void {
  failed = true;
}

$effect(() => {
  if (frame) onFrame(frame);
  else onFrame(null);
  return () => onFrame(null);
});
</script>

<div class="document-viewer">
  <div class="document-viewer-card" style:display={open ? 'none' : ''}>
    <button
      type="button"
      class="document-viewer-placeholder"
      aria-label={t('document_viewer.open')}
      onclick={(e) => {
        e.stopPropagation();
        openViewer();
      }}
    >
      <span class="document-viewer-icon">📄</span>
      <span class="document-viewer-label">{t('document_viewer.open')}</span>
      <span class="document-viewer-hint">{t('document_viewer.hint')}</span>
    </button>
    <a
      class="document-viewer-open-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onclick={(e) => e.stopPropagation()}>{t('document_viewer.open_new_tab')}</a
    >
  </div>

  <div class="document-viewer-error" style:display={failed ? '' : 'none'}>{t('document_viewer.error')}</div>

  <div class="document-viewer-frame-wrap" style:display={open ? '' : 'none'}>
    {#if open}
      <iframe
        bind:this={frame}
        class="document-viewer-frame"
        title={t('document_viewer.title')}
        referrerpolicy="no-referrer"
        src={viewerSrc}
      ></iframe>
    {/if}
  </div>
</div>
