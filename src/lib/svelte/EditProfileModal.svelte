<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onDestroy, onMount } from 'svelte';
import { NAME_COLOR_PALETTE, normalizeNameColor } from '../../../shared/name-color.ts';
import { updateMeCache } from '../auth-cache';
import { attachPlusBadge } from '../avatar.js';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { t } from '../i18n.ts';
import { registerModal } from '../modal-state.js';
import { nativeApiHref } from '../native-api.ts';
import { showToast } from '../toast.ts';
import { createTitleIcon as titleIcon, titleName } from '../user-title.js';

interface ModalUser {
  username: string;
  display_name?: string;
  bio?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
  equipped_title_id?: string | null;
  header_key?: string | null;
}

interface TitleOption {
  id: string;
  icon: string;
  name: string;
}

interface Props {
  currentUser: ModalUser;
  onSave: () => void;
  onClose: () => void;
}
let { currentUser, onSave, onClose }: Props = $props();

const canCustomizeNameColor = currentUser.badge_type === 'flaxia_plus';
const originalNameColor = canCustomizeNameColor ? normalizeNameColor(currentUser.name_color) : null;

let displayName = $state(currentUser.display_name || '');
let bio = $state(currentUser.bio || '');
let selectedNameColor = $state<string | null>(originalNameColor);
let colorOpen = $state(false);
let nameField = $state<HTMLDivElement>();
let avatarWrap = $state<HTMLDivElement>();

let avatarFile = $state<File | null>(null);
let avatarPreview = $state<string | null>(null);
let headerFile = $state<File | null>(null);
let headerPreview = $state<string | null>(null);
let headerRemoved = $state(false);

let titleOptions = $state<TitleOption[]>([]);
let selectedTitleId = $state(currentUser.equipped_title_id ?? '');
let originalTitleId = $state(currentUser.equipped_title_id ?? '');
let titleLoaded = $state(false);
let titleTouched = false;
let titleOpen = $state(false);
let titlePicker = $state<HTMLDivElement>();
let titleHint = $state(t('edit_profile.title_loading'));

let saving = $state(false);
let avatarInput = $state<HTMLInputElement>();
let headerInput = $state<HTMLInputElement>();
let nameColorChanged = $state(false);

const displayNameValid = $derived(displayName.trim().length <= 50);
const bioValid = $derived(bio.length <= 200);
const hasAvatarChange = $derived(Boolean(avatarFile));
const hasHeaderChange = $derived(Boolean(headerFile) || headerRemoved);
const hasChanges = $derived(
  displayName.trim() !== (currentUser.display_name || '') ||
    bio !== (currentUser.bio || '') ||
    selectedTitleId !== originalTitleId ||
    hasAvatarChange ||
    hasHeaderChange ||
    nameColorChanged,
);
const canSave = $derived(hasChanges && displayNameValid && bioValid && !saving);
const bannerUrl = $derived(
  headerPreview ??
    (!headerRemoved && currentUser.header_key ? nativeApiHref(`/api/images/${currentUser.header_key}`) : ''),
);
const avatarUrl = $derived(
  avatarPreview ?? (currentUser.avatar_key ? nativeApiHref(`/api/images/${currentUser.avatar_key}`) : ''),
);
const selectedTitle = $derived(titleOptions.find((title) => title.id === selectedTitleId));

function mountIcon(node: HTMLElement, icon: string): void {
  const element = titleIcon(icon, 'title-picker-icon');
  if (element) node.appendChild(element);
}

function pickHeader(): void {
  headerInput?.click();
}

function onHeaderFile(event: Event): void {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.type.match(/^image\/(jpeg|jpg|png|gif|webp)$/)) {
    showToast(t('edit_profile.header_type_error'), true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast(t('edit_profile.header_size_error'), true);
    return;
  }
  if (headerPreview) URL.revokeObjectURL(headerPreview);
  headerFile = file;
  headerRemoved = false;
  headerPreview = URL.createObjectURL(file);
}

function removeHeader(): void {
  if (headerPreview) URL.revokeObjectURL(headerPreview);
  headerPreview = null;
  headerFile = null;
  headerRemoved = true;
}

function onAvatarFile(event: Event): void {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.type.match(/^image\/(jpeg|jpg|png|gif|webp)$/)) {
    showToast(t('edit_profile.avatar_type_error'), true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast(t('edit_profile.avatar_size_error'), true);
    return;
  }
  if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  avatarFile = file;
  avatarPreview = URL.createObjectURL(file);
}

function chooseColor(color: string | null): void {
  selectedNameColor = color;
  nameColorChanged = selectedNameColor !== originalNameColor;
  colorOpen = false;
}

async function save(): Promise<void> {
  if (!canSave) return;
  saving = true;
  const form = new FormData();
  form.append('display_name', displayName.trim());
  form.append('bio', bio);
  if (titleLoaded) form.append('equipped_title_id', selectedTitleId);
  if (nameColorChanged) form.append('name_color', selectedNameColor ?? '');
  if (avatarFile) form.append('avatar', avatarFile);
  if (headerFile) form.append('header', headerFile);
  else if (headerRemoved) form.append('remove_header', '1');

  try {
    const response = await fetch('/api/users/me', { method: 'PATCH', body: form });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to save: ${response.status} ${errorText}`);
    }
    const updated = await response.json();
    updateMeCache(updated as Record<string, unknown>);
    window.dispatchEvent(new CustomEvent('profileUpdated', { detail: updated }));
    onSave();
    onClose();
  } catch (error) {
    console.error('Failed to save profile:', error);
    showToast('Failed to save. Please try again.', true);
    saving = false;
  }
}

async function requestClose(): Promise<void> {
  if (hasChanges && !(await confirmDialog(t('edit_profile.unsaved_changes')))) return;
  onClose();
}

$effect(() => {
  if (!colorOpen) return;
  const onDocumentClick = (event: MouseEvent) => {
    if (nameField && !nameField.contains(event.target as Node)) colorOpen = false;
  };
  document.addEventListener('click', onDocumentClick);
  return () => document.removeEventListener('click', onDocumentClick);
});

$effect(() => {
  if (!titleOpen) return;
  const onPointerDown = (event: PointerEvent) => {
    if (titlePicker && !titlePicker.contains(event.target as Node)) titleOpen = false;
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  return () => document.removeEventListener('pointerdown', onPointerDown, true);
});

onMount(() => {
  const unregister = registerModal();
  if (avatarWrap) attachPlusBadge(avatarWrap, currentUser.badge_type);
  fetch('/api/titles/me', { credentials: 'include' })
    .then((response) =>
      response.ok
        ? (response.json() as Promise<{
            titles?: Array<{ id: string; icon: string; name: string; name_ja?: string | null }>;
            equipped_title_id?: string | null;
          }>)
        : Promise.reject(new Error(String(response.status))),
    )
    .then((data) => {
      titleOptions = (data.titles ?? []).map((title) => ({
        id: title.id,
        icon: title.icon,
        name: titleName(title),
      }));
      if (!titleTouched) {
        originalTitleId = data.equipped_title_id ?? '';
        selectedTitleId = originalTitleId;
      }
      if (selectedTitleId && !titleOptions.some((title) => title.id === selectedTitleId)) {
        selectedTitleId = '';
      }
      titleLoaded = true;
      titleHint = titleOptions.length === 0 ? t('edit_profile.title_empty') : t('edit_profile.title_hint');
    })
    .catch(() => {
      titleHint = t('edit_profile.title_load_failed');
    });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (titleOpen) {
      event.stopPropagation();
      titleOpen = false;
      return;
    }
    if (colorOpen) {
      event.stopPropagation();
      colorOpen = false;
      return;
    }
    void requestClose();
  };
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('keydown', onKeyDown);
    unregister();
  };
});

onDestroy(() => {
  if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  if (headerPreview) URL.revokeObjectURL(headerPreview);
});
</script>

<div
  class="edit-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) void requestClose();
  }}
>
  <div class="edit-modal" role="dialog" aria-modal="true" aria-label={t('edit_profile.title')}>
    <div class="edit-header">
      <h2>{t('edit_profile.title')}</h2>
      <button type="button" class="edit-close" aria-label={t('common.close') || 'Close'} onclick={() => void requestClose()}>
        ✕
      </button>
    </div>

    <div
      class="edit-banner"
      class:edit-banner--set={Boolean(bannerUrl)}
      style:background-image={bannerUrl ? `url(${bannerUrl})` : undefined}
      role="button"
      tabindex="0"
      onclick={pickHeader}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') pickHeader();
      }}
    >
      <div class="edit-banner-overlay">
        {bannerUrl ? t('edit_profile.header_change') : t('edit_profile.header_add')}
      </div>
      {#if bannerUrl}
        <button
          type="button"
          class="edit-banner-remove"
          aria-label={t('edit_profile.header_remove') || 'Remove header'}
          onclick={(event) => {
            event.stopPropagation();
            removeHeader();
          }}
        >
          ✕
        </button>
      {/if}
      <input
        bind:this={headerInput}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp"
        hidden
        onchange={onHeaderFile}
      />
    </div>

    <div class="edit-avatar-row">
      <div class="edit-avatar-wrap" bind:this={avatarWrap}>
        <button
          type="button"
          class="edit-avatar"
          class:edit-avatar--image={Boolean(avatarUrl)}
          style:background-image={avatarUrl ? `url(${avatarUrl})` : undefined}
          aria-label={t('edit_profile.avatar') || 'Change avatar'}
          onclick={() => avatarInput?.click()}
        >
          {#if !avatarUrl}
            {currentUser.username.charAt(0).toUpperCase()}
          {/if}
        </button>
        <div class="edit-avatar-overlay">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
        </div>
        <input
          bind:this={avatarInput}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp"
          hidden
          onchange={onAvatarFile}
        />
      </div>
    </div>

    <div class="edit-form">
      <label class="edit-label" for="edit-display-name">{t('edit_profile.display_name')}</label>
      <div class="edit-name-field" bind:this={nameField}>
        <input
          id="edit-display-name"
          class="edit-input"
          class:edit-input--color={Boolean(selectedNameColor)}
          style:color={selectedNameColor ?? undefined}
          type="text"
          bind:value={displayName}
        />
        {#if canCustomizeNameColor}
          <button
            type="button"
            class="edit-color-button"
            title={t('edit_profile.name_color')}
            aria-label={t('edit_profile.name_color')}
            aria-haspopup="listbox"
            aria-expanded={colorOpen}
            style:color={selectedNameColor ?? 'var(--text-muted)'}
            onclick={(event) => {
              event.stopPropagation();
              colorOpen = !colorOpen;
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle>
              <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle>
              <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle>
              <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle>
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path>
            </svg>
          </button>
          {#if colorOpen}
            <div class="edit-color-popover" role="listbox" aria-label={t('edit_profile.name_color')}>
              <button
                type="button"
                class="edit-swatch edit-swatch--default"
                role="option"
                aria-selected={selectedNameColor === null}
                aria-label={t('edit_profile.name_color_default')}
                onclick={() => chooseColor(null)}
              >×</button>
              {#each NAME_COLOR_PALETTE as color (color)}
                <button
                  type="button"
                  class="edit-swatch"
                  role="option"
                  aria-selected={selectedNameColor === color}
                  aria-label={color}
                  style:background={color}
                  onclick={() => chooseColor(color)}
                ></button>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
      <div class="edit-error">{displayNameValid ? '' : 'Display name must be 50 characters or less'}</div>

      <label class="edit-label" for="edit-bio">{t('edit_profile.bio')}</label>
      <textarea id="edit-bio" class="edit-input edit-textarea" rows="3" bind:value={bio}></textarea>
      <div class="edit-counter" class:edit-counter--max={bio.length >= 200} class:edit-counter--warn={bio.length > 180 && bio.length < 200}>
        {bio.length}/200
      </div>
      <div class="edit-error">{bioValid ? '' : 'Bio must be 200 characters or less'}</div>

      <label class="edit-label" for="edit-title-trigger">{t('edit_profile.title_badge')}</label>
      <div class="edit-title-picker" bind:this={titlePicker}>
        <button
          id="edit-title-trigger"
          type="button"
          class="edit-title-trigger"
          disabled={titleOptions.length === 0}
          aria-haspopup="listbox"
          aria-expanded={titleOpen}
          onclick={() => (titleOpen = !titleOpen)}
          onkeydown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              titleOpen = true;
            } else if (event.key === 'Escape') {
              titleOpen = false;
            }
          }}
        >
          {#if selectedTitle?.icon}
            <span use:mountIcon={selectedTitle.icon}></span>
          {:else}
            <span class="title-picker-icon title-picker-icon-empty" aria-hidden="true"></span>
          {/if}
          <span class="title-picker-label">{selectedTitle?.name ?? t('edit_profile.title_none')}</span>
          <span class="title-picker-chevron" aria-hidden="true">▾</span>
        </button>
        {#if titleOpen}
          <div class="edit-title-menu" role="listbox">
            <button
              type="button"
              class="edit-title-option"
              role="option"
              aria-selected={selectedTitleId === ''}
              onclick={() => {
                selectedTitleId = '';
                titleTouched = true;
                titleOpen = false;
              }}
            >
              <span class="title-picker-icon title-picker-icon-empty" aria-hidden="true"></span>
              <span class="title-picker-option-label">{t('edit_profile.title_none')}</span>
              <span class="title-picker-check" aria-hidden="true">✓</span>
            </button>
            {#each titleOptions as option (option.id)}
              <button
                type="button"
                class="edit-title-option"
                role="option"
                aria-selected={selectedTitleId === option.id}
                onclick={() => {
                  selectedTitleId = option.id;
                  titleTouched = true;
                  titleOpen = false;
                }}
              >
                {#if option.icon}
                  <span use:mountIcon={option.icon}></span>
                {:else}
                  <span class="title-picker-icon title-picker-icon-empty" aria-hidden="true"></span>
                {/if}
                <span class="title-picker-option-label">{option.name}</span>
                <span class="title-picker-check" aria-hidden="true">✓</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="edit-title-hint">{titleHint}</div>

      <button type="button" class="edit-save" disabled={!canSave} onclick={() => void save()}>
        {saving ? '…' : t('edit_profile.save')}
      </button>
    </div>
  </div>
</div>

<style>
  .edit-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .edit-modal {
    width: 600px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
    border-radius: 16px;
    background: var(--bg-primary);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .edit-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
  }

  .edit-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .edit-close {
    padding: 0.25rem 0.5rem;
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    cursor: pointer;
  }

  .edit-banner {
    position: relative;
    height: 140px;
    overflow: hidden;
    border-bottom: 1px solid var(--border-color);
    background-color: var(--bg-secondary);
    background-position: center;
    background-size: cover;
    cursor: pointer;
  }

  .edit-banner--set {
    cursor: default;
  }

  .edit-banner-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: rgba(0, 0, 0, 0.35);
    color: #fff;
    font-size: 0.9rem;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .edit-banner:hover .edit-banner-overlay,
  .edit-banner:focus-visible .edit-banner-overlay {
    opacity: 1;
  }

  .edit-banner-remove {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 1.75rem;
    height: 1.75rem;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
  }

  .edit-avatar-row {
    display: flex;
    align-items: flex-end;
    margin-top: -40px;
    padding: 0 1.5rem;
  }

  .edit-avatar-wrap {
    position: relative;
    width: 80px;
    height: 80px;
  }

  .edit-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 80px;
    height: 80px;
    overflow: visible;
    border: 4px solid var(--bg-primary);
    border-radius: 50%;
    background-color: var(--accent);
    background-position: center;
    background-size: cover;
    color: var(--on-accent);
    font-size: 2rem;
    cursor: pointer;
  }

  .edit-avatar--image {
    color: transparent;
  }

  .edit-avatar-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.5);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }

  .edit-avatar-wrap:hover .edit-avatar-overlay {
    opacity: 1;
  }

  .edit-form {
    padding: 1.5rem;
  }

  .edit-label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
  }

  .edit-input {
    box-sizing: border-box;
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1rem;
  }

  .edit-input--color {
    padding-right: 2.75rem;
  }

  .edit-textarea {
    margin-bottom: 0.5rem;
    resize: vertical;
  }

  .edit-name-field {
    position: relative;
  }

  .edit-color-button {
    position: absolute;
    top: 50%;
    right: 0.4rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    transform: translateY(-50%);
  }

  .edit-color-popover {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    z-index: 5;
    display: grid;
    grid-template-columns: repeat(6, 1.75rem);
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 12px;
    background: var(--bg-primary);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }

  .edit-swatch {
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }

  .edit-swatch[aria-selected='true'] {
    outline: 2px solid var(--text-primary);
    outline-offset: 2px;
  }

  .edit-swatch--default {
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
  }

  .edit-error {
    min-height: 1.25rem;
    margin: 0.25rem 0 1rem;
    color: var(--danger-text);
    font-size: 0.875rem;
  }

  .edit-counter {
    margin-bottom: 0.25rem;
    color: var(--text-muted);
    font-size: 0.875rem;
    text-align: right;
  }

  .edit-counter--warn {
    color: var(--accent);
  }

  .edit-counter--max {
    color: var(--danger);
  }

  .edit-title-picker {
    position: relative;
  }

  .edit-title-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1rem;
    text-align: left;
    cursor: pointer;
  }

  .edit-title-trigger:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .title-picker-label {
    flex: 1;
  }

  .title-picker-chevron {
    color: var(--text-muted);
  }

  .edit-title-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 240px;
    overflow-y: auto;
    padding: 0.25rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }

  .edit-title-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }

  .edit-title-option:hover,
  .edit-title-option[aria-selected='true'] {
    background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  }

  .title-picker-option-label {
    flex: 1;
  }

  .title-picker-check {
    color: var(--accent);
    visibility: hidden;
  }

  .edit-title-option[aria-selected='true'] .title-picker-check {
    visibility: visible;
  }

  .title-picker-icon-empty {
    display: inline-block;
    width: 18px;
    height: 18px;
  }

  .edit-title-hint {
    margin-bottom: 1rem;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .edit-save {
    padding: 0.75rem 2rem;
    border: 0;
    border-radius: 9999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }

  .edit-save:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
