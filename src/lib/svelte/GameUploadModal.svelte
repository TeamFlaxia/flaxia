<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { FREE_UPLOAD_MAX_BYTES } from '../../../shared/upload-limits.ts';
import { t } from '../i18n.ts';
import {
  canSubmitGameUpload,
  commitGamePost,
  fileSizeParts,
  gameFileTypeLabel,
  gameUploadFileError,
  prepareGamePost,
  thumbnailFileError,
  uploadGameFile,
} from '../modals/game-upload.ts';
import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';
import { showToast } from '../toast.ts';

interface Props {
  onUploaded: (postId: string) => void;
  maxUploadBytes?: number;
  onClose: () => void;
}

let { onUploaded, maxUploadBytes, onClose }: Props = $props();

let overlayEl: HTMLDivElement;
let dialogEl: HTMLDivElement;
let controller: ModalBehavior | null = null;
let fileInputEl: HTMLInputElement;
let thumbnailInputEl: HTMLInputElement;
let title = $state('');
let selectedFile = $state<File | null>(null);
let selectedThumbnail = $state<File | null>(null);
let submitting = $state(false);

const maxBytes = $derived(maxUploadBytes ?? FREE_UPLOAD_MAX_BYTES);
const canSubmit = $derived(canSubmitGameUpload({ hasFile: Boolean(selectedFile), title, submitting }));

function pickFile(): void {
  fileInputEl?.click();
}

function pickThumbnail(): void {
  thumbnailInputEl?.click();
}

function onFileAreaKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    pickFile();
  }
}

function onFileChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const error = gameUploadFileError(file, maxBytes);
  if (error === 'file_too_large') {
    showToast(t('arcade.upload_file_too_large'), true);
    return;
  }
  if (error === 'file_type') {
    showToast(t('arcade.upload_file_type_error'), true);
    return;
  }
  selectedFile = file;
}

function onThumbnailChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const error = thumbnailFileError(file);
  if (error === 'thumbnail_too_large') {
    showToast(t('arcade.upload_thumbnail_too_large'), true);
    return;
  }
  if (error === 'thumbnail_type') {
    showToast(t('arcade.upload_thumbnail_type_error'), true);
    return;
  }
  selectedThumbnail = file;
  input.value = '';
}

function sizeLabel(file: File): string {
  const parts = fileSizeParts(file.size);
  return t(`file_size.${parts.unit}`, { size: parts.value });
}

async function submit(): Promise<void> {
  const file = selectedFile;
  const value = title.trim();
  if (!file) {
    showToast(t('arcade.upload_file_required'), true);
    return;
  }
  if (!value || value.length > 200) {
    showToast(t('arcade.upload_title_required'), true);
    return;
  }
  if (submitting) return;

  submitting = true;
  try {
    const prepared = await prepareGamePost(file);
    if (!prepared?.zipUploadUrl || !prepared?.zipKey) throw new Error('Failed to prepare post');

    const uploaded = await uploadGameFile(file, prepared.zipUploadUrl);
    if (!uploaded) throw new Error('Failed to upload game file');

    const committed = await commitGamePost(prepared.postId, prepared.zipKey, value, selectedThumbnail);
    if (!committed) throw new Error('Failed to publish game');

    showToast(t('arcade.upload_success'));
    submitting = false;
    controller?.close();
    onUploaded(prepared.postId);
  } catch (error) {
    console.error('Game upload failed:', error);
    showToast(t('arcade.upload_failed'), true);
    submitting = false;
  }
}

onMount(() => {
  controller = attachModalBehavior({
    overlay: overlayEl,
    dialog: dialogEl,
    onClose,
    animated: false,
    canClose: () => !submitting,
  });
  return () => controller?.destroy();
});
</script>

<div
  class="game-upload-overlay"
  bind:this={overlayEl}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) controller?.close();
  }}
>
  <div
    class="game-upload-dialog"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-labelledby="game-upload-title"
    tabindex="-1"
  >
    <div class="game-upload-header">
      <div class="game-upload-heading">
        <span class="game-upload-title" id="game-upload-title">{t('arcade.upload_title')}</span>
        <span class="game-upload-subtitle">{t('arcade.upload_subtitle')}</span>
      </div>
      <button
        type="button"
        class="game-upload-close"
        title={t('common.close')}
        aria-label={t('common.close')}
        onclick={() => controller?.close()}
      >
        ✕
      </button>
    </div>

    <div class="game-upload-body">
      <div>
        <label class="game-upload-label" for="game-upload-name">{t('arcade.upload_title_label')}</label>
        <input
          id="game-upload-name"
          class="game-upload-name"
          type="text"
          maxlength="200"
          placeholder={t('arcade.upload_title_placeholder')}
          bind:value={title}
        />
      </div>

      <div
        class="game-upload-drop"
        role="button"
        tabindex="0"
        onclick={pickFile}
        onkeydown={onFileAreaKeydown}
      >
        <div class="game-upload-filelabel">
          <span class="game-upload-emoji">📦</span>
          {#if selectedFile}
            <div class="game-upload-filename">
              {selectedFile.name}{gameFileTypeLabel(selectedFile.name)}
            </div>
            <div class="game-upload-filesize">{sizeLabel(selectedFile)}</div>
          {:else}
            <div>{t('arcade.upload_file_hint')}</div>
          {/if}
        </div>
        <input
          bind:this={fileInputEl}
          class="game-upload-fileinput"
          type="file"
          accept=".zip,.html,.htm"
          onchange={onFileChange}
        />
      </div>

      <div class="game-upload-thumbrow">
        <button type="button" class="game-upload-thumbbtn" onclick={pickThumbnail}>
          {t('arcade.upload_thumbnail_button')}
        </button>
        <span class="game-upload-thumbhint">{selectedThumbnail?.name ?? t('arcade.upload_thumbnail_hint')}</span>
        <input
          bind:this={thumbnailInputEl}
          class="game-upload-thumbinput"
          type="file"
          accept=".jpg,.jpeg,.png,.gif,.webp"
          onchange={onThumbnailChange}
        />
      </div>
    </div>

    <div class="game-upload-footer">
      <button type="button" class="game-upload-cancel" onclick={() => controller?.close()}>
        {t('common.cancel')}
      </button>
      <button type="button" class="game-upload-submit" disabled={!canSubmit} onclick={() => void submit()}>
        {submitting ? t('arcade.upload_uploading') : t('arcade.upload_submit')}
      </button>
    </div>
  </div>
</div>

<style>
  .game-upload-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .game-upload-dialog {
    display: flex;
    flex-direction: column;
    width: 92%;
    max-width: 480px;
    max-height: 88vh;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-primary);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .game-upload-header {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .game-upload-heading {
    display: flex;
    flex-direction: column;
  }

  .game-upload-title {
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 600;
  }

  .game-upload-subtitle {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .game-upload-close {
    padding: 0.25rem;
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
  }

  .game-upload-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1rem;
    overflow-y: auto;
  }

  .game-upload-label {
    display: block;
    margin-bottom: 0.3rem;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .game-upload-name {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.9rem;
  }

  .game-upload-drop {
    padding: 1.2rem;
    border: 1.5px dashed var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    text-align: center;
    cursor: pointer;
    transition:
      border-color 0.2s,
      background 0.2s;
  }

  .game-upload-filelabel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }

  .game-upload-emoji {
    font-size: 2rem;
    line-height: 1;
  }

  .game-upload-filename {
    color: var(--text-primary);
    font-size: 0.9rem;
    font-weight: 600;
    word-break: break-all;
  }

  .game-upload-filesize {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .game-upload-fileinput,
  .game-upload-thumbinput {
    display: none;
  }

  .game-upload-thumbrow {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .game-upload-thumbbtn {
    flex-shrink: 0;
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .game-upload-thumbhint {
    flex: 1;
    color: var(--text-muted);
    font-size: 0.75rem;
    word-break: break-all;
  }

  .game-upload-footer {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
    gap: 0.6rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border);
  }

  .game-upload-cancel {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .game-upload-submit {
    padding: 0.5rem 1.4rem;
    border: none;
    border-radius: 9999px;
    background: var(--accent);
    color: #000;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }

  .game-upload-submit:disabled {
    opacity: 0.5;
  }
</style>
