<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { canUsePostColors, maxMediaAttachmentsForUser } from '../../../shared/entitlements.ts';
import { stripPostColors } from '../../../shared/post-colors.ts';
import type { Post, QuotedPost } from '../../../shared/types/post.ts';
import { openStampPicker } from '../../components/StampPicker.ts';
import {
  buildPollData,
  canSubmit,
  charMeter,
  fileExtension,
  isGameFile,
  POST_CHAR_LIMIT,
  validateSubmission,
} from '../composer/logic.ts';
import { mountMediaList } from '../composer/media-list.ts';
import { submitPost } from '../composer/submit.ts';
import type { AttachPreviewHandle } from '../file-preview.ts';
import { checkImageSizeLimit, detectAttachKind, renderFilePreview } from '../file-preview.ts';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { attachIcons, icon } from '../icons.ts';
import { nativeApiHref } from '../native-api.ts';
import { showToast } from '../toast.ts';
import { deleteVaultItem, deleteVaultItems, listVaultItems, newVaultItemId, saveVaultItem } from '../vault/items.ts';
import { getVaultKey, isVaultUnlocked, subscribeVault, tryDeviceUnlock } from '../vault/session.ts';

interface CurrentUser {
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  id?: string;
}

interface Draft {
  id: string;
  text: string;
  savedAt: number;
}

interface Props {
  onPostCreated?: (post: Post) => void;
  currentUser?: CurrentUser | null;
  onDraftSaved?: () => void;
  quotedPost?: QuotedPost | null;
}

let { onPostCreated, currentUser = null, onDraftSaved, quotedPost = null }: Props = $props();
let user = $state(currentUser);

const MAX_FILE = 25 * 1024 * 1024;
const SAVED_DRAFTS_KEY = 'flaxia.saved_drafts';
const AUTOSAVE_KEY = 'flaxia.post_autosave';

let root: HTMLDivElement;
let textarea: HTMLTextAreaElement;
let fileInput: HTMLInputElement;
let thumbnailInput: HTMLInputElement;
let filePreviewHost: HTMLDivElement;
let mediaListHost: HTMLDivElement;
let thumbnailImage: HTMLImageElement;

let text = $state('');
let submitting = $state(false);
let errorText = $state('');
let vaultNotice = $state('');
let selectedFile = $state<File | null>(null);
let selectedMedia = $state<File[]>([]);
let selectedThumbnail = $state<File | null>(null);
let pollActive = $state(false);
let pollQuestion = $state('');
let pollOptions = $state<string[]>(['', '']);
let pollDuration = $state('86400000');
let savedDrafts = $state<Draft[]>([]);
let draftStorageMode = $state<'loading' | 'local' | 'vault' | 'locked'>('loading');
let draftsOpen = $state(false);
let attachMenuOpen = $state(false);
let mentionOpen = $state(false);
let mentionItems = $state<Array<{ label: string; sub?: string }>>([]);
let mentionIndex = $state(0);
let mentionToken = 0;
let dragOver = $state(false);
let loadedDraftId: string | null = null;
let previewHandle: AttachPreviewHandle | null = null;
let mediaHandles: AttachPreviewHandle[] = [];
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let mentionTimer: ReturnType<typeof setTimeout> | null = null;
let vaultUnsubscribe: (() => void) | null = null;

const maxMedia = $derived(user ? maxMediaAttachmentsForUser(user as never) : 1);
const char = $derived(charMeter(text.length));
const canPost = $derived(canSubmit(text, quotedPost, submitting));
const progress = $derived(char.ratio.toFixed(3));

onMount(() => {
  if (root) attachIcons(root);
  void initializeDrafts();
  restoreAutosave();
  vaultUnsubscribe = subscribeVault(() => void handleVaultChange());
  return () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (mentionTimer) clearTimeout(mentionTimer);
    vaultUnsubscribe?.();
    previewHandle?.destroy();
    mediaHandles.forEach((h) => {
      h.destroy();
    });
  };
});

function clearError(): void {
  errorText = '';
}

function showError(message: string): void {
  errorText = message;
}

function autosize(): void {
  if (!textarea || textarea.scrollHeight <= 0) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
}

function onTextInput(): void {
  text = textarea.value;
  autosize();
  scheduleAutosave();
  handleMentionInput();
}

function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void saveAutosave(), 500);
}

function saveAutosave(): void {
  if (!text && !pollActive) return;
  const payload = {
    text,
    savedAt: Date.now(),
    poll: pollActive ? { question: pollQuestion, options: pollOptions, duration: pollDuration } : undefined,
  };
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch {
    // best effort
  }
}

function restoreAutosave(): void {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as { text?: string; poll?: { question: string; options: string[]; duration: string } };
    if (!data.text || text || quotedPost) return;
    text = data.text;
    if (data.poll) {
      pollActive = true;
      pollQuestion = data.poll.question;
      pollOptions = [...data.poll.options];
      pollDuration = data.poll.duration;
    }
    queueMicrotask(autosize);
  } catch {
    // ignore corrupt autosave
  }
}

async function initializeDrafts(): Promise<void> {
  if (isVaultUnlocked() && getVaultKey()) {
    draftStorageMode = 'vault';
    vaultNotice = '';
    await loadDrafts();
    return;
  }
  draftStorageMode = 'local';
  try {
    const raw = localStorage.getItem(SAVED_DRAFTS_KEY);
    savedDrafts = raw ? (JSON.parse(raw) as Draft[]) : [];
  } catch {
    savedDrafts = [];
  }
}

async function handleVaultChange(): Promise<void> {
  if (!getVaultKey()) {
    if (draftStorageMode === 'vault') {
      draftStorageMode = 'locked';
      savedDrafts = [];
      vaultNotice = t('composer.vault_unlock_required');
      onDraftSaved?.();
    }
    return;
  }
  if (draftStorageMode === 'locked' || draftStorageMode === 'local') {
    draftStorageMode = 'loading';
    vaultNotice = '';
    await initializeDrafts();
  }
}

async function loadDrafts(): Promise<void> {
  try {
    const items = await listVaultItems<Draft>('post_draft');
    savedDrafts = items
      .map((item) => item.value)
      .filter((draft) => draft && typeof draft.text === 'string')
      .slice(0, 20);
  } catch {
    savedDrafts = [];
  }
}

async function saveDraft(): Promise<void> {
  if (!text.trim()) return;
  const draft: Draft = { id: loadedDraftId ?? newVaultItemId(), text, savedAt: Date.now() };
  try {
    if (draftStorageMode === 'vault' && getVaultKey()) {
      await saveVaultItem(draft.id, 'post_draft', draft);
    } else {
      const others = savedDrafts.filter((d) => d.id !== draft.id);
      localStorage.setItem(SAVED_DRAFTS_KEY, JSON.stringify([draft, ...others].slice(0, 20)));
    }
    savedDrafts = [draft, ...savedDrafts.filter((d) => d.id !== draft.id)].slice(0, 20);
    loadedDraftId = draft.id;
    onDraftSaved?.();
  } catch {
    vaultNotice = t('composer.vault_save_failed');
  }
}

async function deleteDraft(id: string): Promise<void> {
  try {
    if (draftStorageMode === 'vault' && getVaultKey()) await deleteVaultItem(id);
    else localStorage.setItem(SAVED_DRAFTS_KEY, JSON.stringify(savedDrafts.filter((d) => d.id !== id)));
    savedDrafts = savedDrafts.filter((d) => d.id !== id);
    onDraftSaved?.();
  } catch {
    // keep the draft visible
  }
}

async function deleteAllDrafts(): Promise<void> {
  try {
    if (draftStorageMode === 'vault' && getVaultKey()) await deleteVaultItems('post_draft');
    else localStorage.removeItem(SAVED_DRAFTS_KEY);
    savedDrafts = [];
    onDraftSaved?.();
  } catch {
    // best effort
  }
}

function loadDraft(draft: Draft): void {
  text = draft.text;
  loadedDraftId = draft.id;
  draftsOpen = false;
  queueMicrotask(autosize);
}

async function unlockVault(): Promise<void> {
  try {
    await tryDeviceUnlock();
    if (isVaultUnlocked()) {
      vaultNotice = '';
      await initializeDrafts();
    }
  } catch {
    vaultNotice = t('composer.vault_unlock_required');
  }
}

function closeDrafts(): void {
  draftsOpen = false;
}

function togglePoll(): void {
  pollActive = !pollActive;
  scheduleAutosave();
}

function addPollOption(): void {
  if (pollOptions.length < 6) pollOptions = [...pollOptions, ''];
}

function removePollOption(index: number): void {
  if (pollOptions.length <= 2) return;
  pollOptions = pollOptions.filter((_, i) => i !== index);
}

function toggleAttachMenu(): void {
  attachMenuOpen = !attachMenuOpen;
  if (attachMenuOpen)
    queueMicrotask(() => {
      if (root) attachIcons(root);
    });
}

function onAttachClick(slot: string): void {
  const accepts: Record<string, string> = {
    image: 'image/*,video/*',
    audio: 'audio/*',
    game: '.zip,.swf,.html,.htm,.js,.wasm',
    document: '.pdf,.txt,.md',
  };
  fileInput.accept = accepts[slot] ?? accepts.image;
  fileInput.multiple = slot !== 'game';
  attachMenuOpen = false;
  fileInput.click();
}

async function onFilesPicked(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const games = files.filter((file) => isGameFile(file.name));
  const media = files.filter((file) => !isGameFile(file.name));
  if (games.length > 0) {
    if (files.length > 1 || media.length > 0 || selectedMedia.length > 0) {
      showToast(t('composer.error_media_game_mix'), true);
      return;
    }
    await selectSingleFile(games[0]);
    return;
  }
  if (selectedFile) {
    showToast(t('composer.error_media_game_mix'), true);
    return;
  }
  for (const file of media) {
    const kind = detectAttachKind(file);
    if (!kind || !['image', 'audio', 'video', 'document'].includes(kind)) {
      showToast(t('composer.error_unsupported_type'), true);
      continue;
    }
    if (selectedMedia.length >= maxMedia) {
      showToast(t('composer.error_too_many_media', { max: maxMedia }), true);
      break;
    }
    const dimError = await checkImageSizeLimit(file);
    if (dimError) {
      showToast(dimError, true);
      continue;
    }
    const total = selectedMedia.reduce((sum, f) => sum + f.size, 0) + file.size;
    if (total > 50 * 1024 * 1024) {
      showToast(t('composer.error_total_too_large', { max: 50 }), true);
      break;
    }
    if (file.size > MAX_FILE) showToast(t('composer.attach_over_size'), false);
    selectedMedia = [...selectedMedia, file];
  }
  renderMediaList();
}

async function selectSingleFile(file: File): Promise<void> {
  const allowed = [
    'image/gif',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'audio/webm',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/zip',
    'application/x-shockwave-flash',
    'application/javascript',
    'text/javascript',
    'application/wasm',
    'text/plain',
    'text/html',
  ];
  const name = file.name.toLowerCase();
  const valid =
    allowed.includes(file.type) ||
    name.endsWith('.swf') ||
    ['.js', '.wasm', '.zip', '.html', '.htm', '.rsp', '.mp4', '.webm', '.mov'].some((ext) => name.endsWith(ext));
  if (!valid) {
    clearFile();
    showToast(t('composer.error_unsupported_type'), true);
    return;
  }
  const dimError = await checkImageSizeLimit(file);
  if (dimError) {
    clearFile();
    showToast(dimError, true);
    return;
  }
  if (file.size > MAX_FILE) showToast(t('composer.attach_over_size'), false);
  selectedFile = file;
  renderFilePreviewHost();
  queueMicrotask(() => {
    const isGame = ['.zip', '.html', '.htm', '.swf'].some((ext) => name.endsWith(ext));
    if (isGame) {
      // thumbnail section is rendered below; reveal via state
      showThumbnail = true;
    }
  });
}

let showThumbnail = $state(false);

function renderFilePreviewHost(): void {
  previewHandle?.destroy();
  previewHandle = null;
  filePreviewHost.replaceChildren();
  if (selectedFile && filePreviewHost) previewHandle = renderFilePreview(selectedFile, filePreviewHost);
}

function clearFile(): void {
  selectedFile = null;
  if (fileInput) fileInput.value = '';
  showThumbnail = false;
  clearThumbnail();
  renderFilePreviewHost();
  clearError();
}

function renderMediaList(): void {
  mediaHandles.forEach((h) => {
    h.destroy();
  });
  if (!mediaListHost) {
    mediaHandles = [];
    return;
  }
  mediaHandles = mountMediaList(mediaListHost, {
    files: selectedMedia,
    removeLabel: t('composer.remove_media'),
    onRemove: (index) => removeMedia(index),
  });
}

function removeMedia(index: number): void {
  selectedMedia = selectedMedia.filter((_, i) => i !== index);
  renderMediaList();
}

function clearThumbnail(): void {
  selectedThumbnail = null;
  if (thumbnailInput) thumbnailInput.value = '';
}

function onThumbnailPicked(file: File | undefined): void {
  if (!file) return;
  if (file.size > 1024 * 1024) {
    showToast(t('composer.error_thumbnail_size'), true);
    return;
  }
  const ext = fileExtension(file.name);
  if (!['jpg', 'jpeg', 'png', 'gif'].includes(ext)) {
    showToast(t('composer.error_thumbnail_type'), true);
    return;
  }
  selectedThumbnail = file;
  if (thumbnailImage) thumbnailImage.src = window.URL['createObjectURL'](file);
}

function openEmoji(target: HTMLElement): void {
  openStampPicker(target, {
    onSelect: (emoji: string) => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      textarea.value = value.slice(0, start) + emoji + value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
      text = textarea.value;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
    },
  });
}

function handleMentionInput(): void {
  const pos = textarea.selectionStart;
  const before = text.slice(0, pos);
  const at = before.match(/@([a-zA-Z0-9_]*)$/);
  const tag = before.match(/#([^\s]*)$/);
  if (mentionTimer) clearTimeout(mentionTimer);
  if (at) {
    const query = at[1];
    mentionTimer = setTimeout(async () => {
      const token = ++mentionToken;
      try {
        const url = query
          ? `/api/search?type=users&q=${encodeURIComponent(query)}&limit=5`
          : '/api/search?type=users&q=a&limit=5';
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok || token !== mentionToken) return;
        const data = (await res.json()) as { results?: Array<{ username: string; display_name: string }> };
        mentionItems = (data.results ?? []).map((u) => ({ label: u.username, sub: u.display_name }));
        mentionIndex = 0;
        mentionOpen = mentionItems.length > 0;
      } catch {
        mentionOpen = false;
      }
    }, 200);
  } else if (tag) {
    const query = tag[1];
    mentionTimer = setTimeout(async () => {
      const token = ++mentionToken;
      try {
        const res = await fetch(`/api/tags/suggest?q=${encodeURIComponent(query)}&limit=5`);
        if (!res.ok || token !== mentionToken) return;
        const data = (await res.json()) as
          | Array<{ tag: string; count: number }>
          | { tags: Array<{ tag: string; count: number }> };
        const tags = Array.isArray(data) ? data : data.tags;
        mentionItems = tags.map((item) => ({ label: item.tag, sub: String(item.count) }));
        mentionIndex = 0;
        mentionOpen = mentionItems.length > 0;
      } catch {
        mentionOpen = false;
      }
    }, 200);
  } else {
    mentionToken++;
    mentionOpen = false;
  }
}

function selectMention(index: number): void {
  const item = mentionItems[index];
  if (!item) return;
  const pos = textarea.selectionStart;
  const before = text.slice(0, pos);
  const atMatch = before.match(/@([a-zA-Z0-9_]*)$/);
  const tagMatch = atMatch ? null : before.match(/#([^\s]*)$/);
  const match = atMatch ?? tagMatch;
  if (!match) return;
  const prefix = atMatch ? '@' : '#';
  const replacement = `${prefix}${item.label} `;
  textarea.value = text.slice(0, pos - match[0].length) + replacement + text.slice(pos);
  text = textarea.value;
  mentionOpen = false;
  textarea.focus();
  scheduleAutosave();
}

function onTextareaKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canPost) {
    e.preventDefault();
    void submit();
    return;
  }
  if (!mentionOpen) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectMention(mentionIndex);
  } else if (e.key === 'Escape') {
    mentionOpen = false;
  }
}

function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    void onFilesPicked(files);
  }
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  dragOver = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  void onFilesPicked(files);
}

async function submit(): Promise<void> {
  if (submitting) return;
  const value = text.trim();
  if (!value) return;
  const issue = validateSubmission({ selectedFile, selectedMedia, maxMediaAttachments: maxMedia });
  if (issue) {
    showToast(t(issue.key, 'max' in issue ? { max: issue.max } : undefined), true);
    return;
  }
  submitting = true;
  try {
    const poll = buildPollData({
      active: pollActive,
      question: pollQuestion,
      options: pollOptions,
      durationMs: Number(pollDuration),
    });
    const post = await submitPost({
      text: value,
      selectedFile,
      selectedMedia,
      selectedThumbnail,
      poll,
      quotedPostId: quotedPost?.id ?? undefined,
    });
    text = '';
    if (textarea) textarea.value = '';
    autosize();
    clearFile();
    selectedMedia = [];
    renderMediaList();
    if (pollActive) togglePoll();
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      // best effort
    }
    loadedDraftId = null;
    onPostCreated?.(post);
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('composer.error_create_failed'), true);
  } finally {
    submitting = false;
  }
}

export function setText(value: string): void {
  text = value;
  if (textarea) textarea.value = value;
  autosize();
  loadedDraftId = null;
  pollActive = false;
}

export function updateCurrentUser(next: CurrentUser | null): void {
  user = next;
}

export function focus(): void {
  textarea?.focus();
}

export function getSavedDrafts(): Draft[] {
  return [...savedDrafts];
}

export function deleteDraftPublic(id: string): void {
  void deleteDraft(id);
}

export function saveDraftPublic(): void {
  void saveDraft();
}

export function deleteAllDraftsPublic(): void {
  void deleteAllDrafts();
}
</script>

<div bind:this={root} class="post-composer" class:post-composer--dragover={dragOver} data-meter-state={char.state} style="--fx-progress: {progress};">
  <div class="composer-body">
    <div class="composer-header">
      <div class="composer-avatar">
        {#if user?.avatar_key}
          <div class="composer-avatar-img" style="background-image: url({nativeApiHref(`/api/images/${user.avatar_key}`)})"></div>
        {:else}
          {user?.username?.charAt(0).toUpperCase() ?? '?'}
        {/if}
      </div>
      <textarea
        bind:this={textarea}
        class="composer-textarea"
        placeholder={t('composer.placeholder')}
        maxlength={POST_CHAR_LIMIT}
        value={text}
        oninput={onTextInput}
        onkeydown={onTextareaKeydown}
        onpaste={onPaste}
      ></textarea>
      {#if mentionOpen}
        <div class="mention-dropdown" style="display:block;">
          {#each mentionItems as item, i (item.label)}
            <button type="button" class="mention-item" class:mention-item--active={i === mentionIndex} onclick={() => selectMention(i)}>
              <strong>{item.label}</strong>
              {#if item.sub}<span>{item.sub}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="composer-progress" aria-hidden="true"><span class="composer-progress-fill"></span></div>

    {#if dragOver}
      <div class="composer-file-dropzone" style="display:flex;">
        <span class="dropzone-text">{t('composer.file_hint')}</span>
      </div>
    {/if}

    {#if quotedPost}
      <div class="composer-quoted-post">
        <div class="quoted-post-body">
          <div class="quoted-post-author">@{quotedPost.username}</div>
          <div class="quoted-post-text">{quotedPost.text}</div>
        </div>
      </div>
    {/if}

    {#if errorText}
      <div class="composer-error">{errorText}</div>
    {/if}
    {#if vaultNotice}
      <div class="composer-vault-notice">
        {vaultNotice}
        {#if draftStorageMode === 'locked'}<button type="button" onclick={unlockVault}>{t('common.unlock')}</button>{/if}
      </div>
    {/if}

    <div class="composer-divider"></div>

    <div class="composer-footer">
      <div class="composer-actions">
        <input bind:this={fileInput} type="file" class="composer-file-input" onchange={(e) => void onFilesPicked(Array.from(e.currentTarget.files ?? []))} />
        <div class="composer-attach-group">
          <button class="composer-file-button composer-attach-menu-toggle" type="button" title={t('composer.attach_button')} aria-expanded={attachMenuOpen} onclick={toggleAttachMenu}>
            <span class="composer-attach-glyph" aria-hidden="true">＋</span>
          </button>
          {#if attachMenuOpen}
            <div class="composer-attach-menu" style="display:block;">
              <button class="composer-file-button composer-file-button--image" type="button" onclick={() => onAttachClick('image')}><span class="action-icon" data-icon="image-video"></span>{t('composer.attach_image_video')}</button>
              <button class="composer-file-button composer-file-button--audio" type="button" onclick={() => onAttachClick('audio')}><span class="action-icon" data-icon="audio"></span>{t('composer.attach_audio')}</button>
              <button class="composer-file-button composer-file-button--game" type="button" onclick={() => onAttachClick('game')}><span class="action-icon" data-icon="game"></span>{t('composer.attach_game')}</button>
              <button class="composer-file-button composer-poll-button" type="button" onclick={togglePoll}><span class="action-icon" data-icon="poll"></span>{t('poll.toggle_button')}</button>
              <button class="composer-file-button composer-file-button--document" type="button" onclick={() => onAttachClick('document')}><span class="action-icon" data-icon="document"></span>{t('composer.attach_document')}</button>
            </div>
          {/if}
        </div>
        <button class="composer-emoji-button" type="button" title={t('composer.emoji_button')} onclick={(e) => { e.stopPropagation(); openEmoji(e.currentTarget); }}>
          <span class="action-icon" data-icon="emoji"></span>
        </button>
        <span class="composer-meter" data-state={char.state} data-empty={char.empty}>
          <span class="composer-char-count">{t('composer.char_count', { current: text.length, max: POST_CHAR_LIMIT })}</span>
        </span>
        <button class="composer-list-drafts" type="button" title={t('composer.list_drafts')} onclick={() => (draftsOpen = !draftsOpen)}>
          <span class="action-icon" data-icon="drafts"></span>
          <span class="composer-draft-count" hidden={savedDrafts.length === 0}>{savedDrafts.length}</span>
        </button>
        {#if draftsOpen}
          <div class="composer-drafts-dropdown" style="display:block;">
            <div class="drafts-dropdown-header">
              <span>{t('composer.list_drafts')}</span>
              <button type="button" onclick={() => void deleteAllDrafts()}>{t('composer.draft_delete_all')}</button>
            </div>
            {#if savedDrafts.length === 0}
              <div class="drafts-empty">{t('composer.no_drafts')}</div>
            {:else}
              {#each savedDrafts as draft (draft.id)}
                <div class="drafts-item">
                  <button type="button" class="drafts-item-text" onclick={() => loadDraft(draft)}>{draft.text}</button>
                  <button type="button" class="drafts-item-delete" onclick={() => void deleteDraft(draft.id)}>×</button>
                </div>
              {/each}
            {/if}
            <button type="button" class="drafts-save" onclick={() => void saveDraft()}>{t('composer.save_draft')}</button>
          </div>
        {/if}
      </div>
      <button class="composer-submit" type="button" disabled={!canPost} onclick={() => void submit()}>
        {submitting ? t('composer.posting') : t('composer.post_button')}
      </button>
    </div>

    {#if pollActive}
      <div class="composer-poll-section" style="display:block;">
        <div class="poll-form">
          <input type="text" class="poll-question-input" placeholder={t('poll.question_placeholder')} maxlength="100" bind:value={pollQuestion} />
          <div class="poll-options-list">
            {#each pollOptions as option, i (i)}
              <div class="poll-option-row">
                <input type="text" class="poll-option-input" bind:value={pollOptions[i]} />
                {#if pollOptions.length > 2}<button type="button" class="poll-option-remove" onclick={() => removePollOption(i)}>×</button>{/if}
              </div>
            {/each}
          </div>
          <div class="poll-duration-row">
            <span class="poll-duration-label">{t('poll.duration')}:</span>
            <select class="poll-duration-select" bind:value={pollDuration}>
              <option value="3600000">{t('poll.duration_1h')}</option>
              <option value="21600000">{t('poll.duration_6h')}</option>
              <option value="86400000">{t('poll.duration_1d')}</option>
              <option value="259200000">{t('poll.duration_3d')}</option>
              <option value="604800000">{t('poll.duration_7d')}</option>
            </select>
          </div>
          <button class="poll-add-option" type="button" onclick={addPollOption}>{t('poll.add_option')}</button>
        </div>
      </div>
    {/if}

    <div class="composer-file-preview" style="display:{selectedFile ? 'block' : 'none'};">
      <div bind:this={filePreviewHost} class="file-preview-host"></div>
    </div>

    <div class="composer-media-list" style="display:{selectedMedia.length > 0 ? 'block' : 'none'};">
      <div bind:this={mediaListHost} class="media-list-items"></div>
      <div class="media-list-meta">
        {t('composer.media_meta', { count: selectedMedia.length, max: maxMedia, size: formatCount(selectedMedia.reduce((s, f) => s + f.size, 0)) })}
      </div>
    </div>

    <div class="composer-thumbnail-section" style="display:{showThumbnail ? 'block' : 'none'};">
      <div class="thumbnail-header"><span>{t('composer.thumbnail_label')}</span></div>
      <div class="thumbnail-input-area">
        <input bind:this={thumbnailInput} type="file" class="composer-thumbnail-input" accept=".jpg,.jpeg,.png,.gif" onchange={(e) => onThumbnailPicked(e.currentTarget.files?.[0])} />
        <button class="thumbnail-button" type="button" onclick={() => thumbnailInput.click()}>{t('composer.thumbnail_button')}</button>
        <span class="thumbnail-hint">{t('composer.thumbnail_hint')}</span>
      </div>
      <div class="thumbnail-preview" style="display:{selectedThumbnail ? 'block' : 'none'};">
        <img bind:this={thumbnailImage} class="thumbnail-image" alt="" />
        <button class="thumbnail-remove" type="button" onclick={clearThumbnail}>×</button>
      </div>
    </div>
  </div>
</div>
