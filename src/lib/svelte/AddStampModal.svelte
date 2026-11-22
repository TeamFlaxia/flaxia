<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import { registerModal } from '../modal-state.js';

interface Props {
  onUploaded: () => void;
  onClose: () => void;
}
let { onUploaded, onClose }: Props = $props();

let nameInput: HTMLInputElement;
let fileInput: HTMLInputElement;
let preview = $state<string | null>(null);
let selectedFile = $state<File | null>(null);
let name = $state('');
let message = $state('');
let uploading = $state(false);

function pick(): void {
  fileInput?.click();
}

function onFile(event: Event): void {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    message = t('settings.custom_emoji_too_large') || 'File too large (max 5MB)';
    return;
  }
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    preview = reader.result as string;
    message = '';
  };
  reader.readAsDataURL(file);
}

async function upload(): Promise<void> {
  const value = name.trim();
  if (!selectedFile || !value) {
    message = t('settings.custom_emoji_fill_all') || 'Please select a file and enter a name';
    return;
  }
  if (!/^:[a-zA-Z0-9_]+:$/.test(value)) {
    message = t('settings.custom_emoji_name_format') || 'Name must be in :colon_format:';
    return;
  }
  uploading = true;
  message = '';
  const form = new FormData();
  form.append('file', selectedFile);
  form.append('name', value);
  try {
    const response = await fetch('/api/stamps', { method: 'POST', credentials: 'include', body: form });
    if (response.ok) {
      onUploaded();
      onClose();
      return;
    }
    const error = (await response.json()) as { error?: string };
    message = error.error || t('settings.custom_emoji_upload_failed') || 'Upload failed';
  } catch {
    message = t('settings.custom_emoji_network_error') || 'Network error';
  } finally {
    uploading = false;
  }
}

onMount(() => {
  const unregister = registerModal();
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', onKey);
  nameInput?.focus();
  return () => {
    document.removeEventListener('keydown', onKey);
    unregister();
  };
});
</script>

<div
  class="stamp-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div class="stamp-modal">
    <div class="stamp-header">
      <h2>{t('settings.add_stamp_modal_title') || 'Add Custom Emoji'}</h2>
      <button type="button" class="stamp-close" aria-label={t('common.close') || 'Close'} onclick={onClose}>✕</button>
    </div>

    <div class="stamp-body">
      <button type="button" class="stamp-preview" onclick={pick}>
        {#if preview}
          <img src={preview} alt="" />
        {:else}
          <span class="stamp-plus">+</span>
          <span>{t('settings.add_stamp_preview') || 'Click to select image'}</span>
        {/if}
      </button>
      <input
        bind:this={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onchange={onFile}
      />

      <label class="stamp-name" for="stamp-name">Name</label>
      <input id="stamp-name" bind:this={nameInput} type="text" placeholder=":name:" bind:value={name} />

      <div class="stamp-message" role="status">{message}</div>

      <button type="button" class="stamp-upload" disabled={uploading} onclick={() => void upload()}>
        {uploading
          ? t('settings.add_stamp_uploading') || 'Uploading...'
          : t('settings.custom_emoji_upload') || 'Upload'}
      </button>
    </div>
  </div>
</div>

<style>
  .stamp-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .stamp-modal {
    width: 400px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
    border-radius: 16px;
    background: var(--bg-primary);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .stamp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .stamp-header h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1.125rem;
    font-weight: 600;
  }

  .stamp-close {
    padding: 0.25rem 0.5rem;
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
  }

  .stamp-body {
    padding: 1.5rem;
  }

  .stamp-preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    width: 120px;
    height: 120px;
    margin: 0 auto 1rem;
    padding: 0;
    overflow: hidden;
    border: 2px dashed var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: 0.8125rem;
    cursor: pointer;
    transition:
      border-color 0.2s,
      background 0.2s;
  }

  .stamp-preview:hover {
    border-color: var(--accent);
    background: var(--bg-hover, rgba(0, 0, 0, 0.02));
  }

  .stamp-preview img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .stamp-plus {
    font-size: 2rem;
    line-height: 1;
  }

  .stamp-name {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
    font-size: 0.875rem;
    font-weight: 500;
  }

  #stamp-name {
    box-sizing: border-box;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: monospace;
    font-size: 0.875rem;
  }

  .stamp-message {
    min-height: 1.25rem;
    margin-top: 0.5rem;
    color: var(--danger);
    font-size: 0.8125rem;
  }

  .stamp-upload {
    width: 100%;
    margin-top: 1rem;
    padding: 0.625rem;
    border: 0;
    border-radius: 6px;
    background: var(--accent);
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .stamp-upload:hover {
    opacity: 0.85;
  }
</style>
