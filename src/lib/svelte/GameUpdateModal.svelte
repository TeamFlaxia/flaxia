<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { maxUploadBytesForUser } from '../../../shared/upload-limits.ts';
import { t } from '../i18n.ts';
import { gameUpdateFileError } from '../modals/dialog-logic.ts';
import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';
import { uploadFileBody } from '../upload.ts';
import { getSessionUser } from './session.ts';

interface Props {
  postId: string;
  sandboxOrigin?: string;
  onUpdated: (versionId: string) => void;
  onClose: () => void;
}

let { postId, onUpdated, onClose }: Props = $props();

let overlayEl: HTMLDivElement;
let dialogEl: HTMLDivElement;
let controller: ModalBehavior | null = null;
let selectedFile = $state<File | null>(null);
let changelog = $state('');
let status = $state('');
let statusError = $state(false);
let busy = $state(false);

function setStatus(message: string, error = false): void {
  status = message;
  statusError = error;
}

function onFileChange(event: Event): void {
  selectedFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
}

async function submit(): Promise<void> {
  const maxBytes = maxUploadBytesForUser(getSessionUser());
  const error = gameUpdateFileError(selectedFile, maxBytes);
  if (error === 'missing') {
    setStatus(t('game.update_error_no_file'), true);
    return;
  }
  if (error === 'not_zip') {
    setStatus(t('game.update_error_not_zip'), true);
    return;
  }
  if (error === 'too_large') {
    setStatus(t('arcade.upload_file_too_large'), true);
    return;
  }
  if (!selectedFile || busy) return;

  busy = true;
  setStatus(t('game.update_status_preparing'));

  try {
    const prepareResponse = await fetch(`/api/posts/${postId}/versions/prepare`, { method: 'POST' });
    if (!prepareResponse.ok) {
      const err = (await prepareResponse.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || 'prepare failed');
    }
    const prepare = (await prepareResponse.json()) as { versionId: string; zipUploadUrl: string };

    setStatus(t('game.update_status_uploading'));
    // Reuse the chunked uploader: anything above the 25MB single-request
    // ceiling is sent as 16MB parts and assembled in R2.
    const uploaded = await uploadFileBody(selectedFile, prepare.zipUploadUrl, 'application/zip');
    if (!uploaded) throw new Error('upload failed');

    setStatus(t('game.update_status_committing'));
    const commitResponse = await fetch(`/api/posts/${postId}/versions/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: prepare.versionId, changelog }),
    });
    if (!commitResponse.ok) {
      const err = (await commitResponse.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || 'commit failed');
    }
    const committed = (await commitResponse.json().catch(() => ({}))) as {
      versionId?: string;
      versionNumber?: number;
    };

    setStatus(t('game.update_status_done'));
    onUpdated(committed.versionId ?? prepare.versionId);
    controller?.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`${t('game.update_error')}: ${message}`, true);
    busy = false;
  }
}

onMount(() => {
  controller = attachModalBehavior({
    overlay: overlayEl,
    dialog: dialogEl,
    onClose,
    animated: false,
    canClose: () => !busy,
  });
  return () => controller?.destroy();
});
</script>

<div
  class="game-update-modal-overlay"
  bind:this={overlayEl}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) controller?.close();
  }}
>
  <div
    class="game-update-modal"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-labelledby="game-update-title"
    tabindex="-1"
  >
    <h2 id="game-update-title">{t('game.update_title')}</h2>
    <p class="game-update-subtitle">{t('game.update_subtitle')}</p>

    <input
      class="game-update-file"
      type="file"
      accept=".zip,application/zip"
      onchange={onFileChange}
    />

    <label class="game-update-label" for="game-update-changelog">{t('game.changelog_label')}</label>
    <textarea
      id="game-update-changelog"
      class="game-update-changelog"
      placeholder={t('game.changelog_placeholder')}
      bind:value={changelog}
    ></textarea>

    <div class="game-update-status" class:game-update-status--error={statusError} aria-live="polite">{status}</div>

    <div class="game-update-actions">
      <button type="button" class="game-update-cancel" disabled={busy} onclick={() => controller?.close()}>
        {t('common.cancel')}
      </button>
      <button type="button" class="game-update-submit" disabled={busy} onclick={() => void submit()}>
        {t('game.update_submit')}
      </button>
    </div>
  </div>
</div>

<style>
  .game-update-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.5);
  }

  .game-update-modal {
    width: 100%;
    max-width: 460px;
    max-height: 85vh;
    padding: 1.25rem;
    overflow-y: auto;
    border-radius: 0.75rem;
    background: var(--bg-primary);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  }

  .game-update-modal h2 {
    margin: 0 0 0.25rem;
    color: var(--text-primary);
    font-size: 1.125rem;
  }

  .game-update-subtitle {
    margin: 0 0 1rem;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .game-update-file {
    display: block;
    width: 100%;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
  }

  .game-update-label {
    display: block;
    margin-bottom: 0.25rem;
    color: var(--text-primary);
    font-size: 0.8125rem;
  }

  .game-update-changelog {
    display: block;
    width: 100%;
    min-height: 80px;
    margin-bottom: 1rem;
    padding: 0.5rem;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.875rem;
  }

  .game-update-status {
    min-height: 1.125rem;
    margin-bottom: 0.75rem;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .game-update-status--error {
    color: var(--danger, #e74c3c);
  }

  .game-update-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .game-update-cancel {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.875rem;
    cursor: pointer;
  }

  .game-update-submit {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--accent, #22c55e);
    color: var(--on-accent);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
</style>
