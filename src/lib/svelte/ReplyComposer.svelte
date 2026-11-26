<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { maxUploadBytesForUser } from '../../../shared/upload-limits.ts';
import { showSignInPrompt } from '../../components/SignInPrompt.ts';
import { attachPlusBadge } from '../avatar.ts';
import { charMeter, POST_CHAR_LIMIT } from '../composer/logic.ts';
import { AuthRequiredError, submitReply } from '../composer/reply-submit.ts';
import type { AttachPreviewHandle } from '../file-preview.ts';
import { checkImageSizeLimit, renderFilePreview } from '../file-preview.ts';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { attachIcons } from '../icons.ts';
// Shared http(s) check for remote ActivityPub media (same rule as the search
// and remote-profile avatar renderers), used by the mention avatar markup.
// biome-ignore lint/correctness/noUnusedImports: used in markup
import { isAbsoluteMediaUrl } from '../media/attachments.ts';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import { showToast } from '../toast.ts';
import { markRecommendationProfileDirty } from '../vault/recommendation-profile.ts';
import { getSessionUser } from './session.ts';

interface CurrentUser {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
}

interface Suggestion {
  key: string;
  kind: 'user' | 'tag' | 'remote';
  value: string;
  display: string;
  sub: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

interface Props {
  postId: string;
  sandboxOrigin: string;
  onReplyCreated: (reply: Post) => void;
  onCancel: () => void;
  prefillText?: string;
  currentUser?: CurrentUser | null;
}

let { postId, onReplyCreated, onCancel, prefillText = '', currentUser = null }: Props = $props();

// Called only from deferred callbacks (onMount/$effect/handlers): reading the
// client-only session during SSR render would break hydration.
function activeUser(): CurrentUser | null {
  return currentUser ?? getSessionUser();
}
let viewer = $state<CurrentUser | null>(null);

let root: HTMLDivElement;
let textarea: HTMLTextAreaElement;
let fileInput: HTMLInputElement;
let avatarEl: HTMLDivElement;
let mentionDropdown: HTMLDivElement;
let previewHost: HTMLDivElement;

let text = $state(prefillText);
let submitting = $state(false);
let selectedFile = $state<File | null>(null);
let dropActive = $state(false);
const maxFileBytes = $derived(maxUploadBytesForUser(viewer));
let suggestions = $state<Suggestion[]>([]);
let activeSuggestion = $state(0);
let mentionOpen = $state(false);
let mentionStartPos = -1;
let mentionType: 'user' | 'tag' = 'user';
let mentionTimer: ReturnType<typeof setTimeout> | null = null;
let mentionToken = 0;
let previewHandle: AttachPreviewHandle | null = null;

const char = $derived(charMeter(text.length));

onMount(() => {
  viewer = activeUser();
  attachIcons(root);
});

onDestroy(() => {
  if (mentionTimer) clearTimeout(mentionTimer);
  previewHandle?.destroy();
});

$effect(() => {
  const user = activeUser();
  viewer = user;
  if (!avatarEl || !user) return;
  avatarEl.textContent = user.username.charAt(0).toUpperCase();
  if (user.avatar_key) {
    const url = nativeApiHref(`/api/images/${user.avatar_key}`);
    const img = new Image();
    img.onload = () => {
      if (!avatarEl) return;
      avatarEl.style.backgroundImage = `url(${url})`;
      avatarEl.style.backgroundSize = 'cover';
      avatarEl.style.backgroundPosition = 'center';
      avatarEl.textContent = '';
    };
    img.src = url;
  }
  avatarEl.style.cursor = 'pointer';
  attachPlusBadge(avatarEl, (user.badge_type as never) ?? null);
});

function autosize(): void {
  if (!textarea || textarea.scrollHeight <= 0) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
}

function onInput(): void {
  text = textarea.value;
  autosize();
  handleMentionInput();
}

function handleMentionInput(): void {
  const pos = textarea.selectionStart;
  const before = text.slice(0, pos);
  // A second '@' switches the token to a cross-instance handle.
  const remote = before.match(/@([a-zA-Z0-9_]{1,30})@([a-zA-Z0-9.-]*)$/);
  const at = remote ? null : before.match(/@([a-zA-Z0-9_]*)$/);
  const tag = remote || at ? null : before.match(/#([^\s]*)$/);
  if (mentionTimer) clearTimeout(mentionTimer);
  if (!remote && !at && !tag) {
    hideDropdown();
    return;
  }
  mentionType = remote || at ? 'user' : 'tag';
  mentionStartPos = pos - (remote ?? at ?? tag)![0].length;
  const query = (remote ?? at ?? tag)![1] || '';
  const remoteQuery = remote ? `${query}@${remote[2]}` : null;
  const token = ++mentionToken;
  mentionTimer = setTimeout(async () => {
    try {
      if (remoteQuery !== null) {
        const res = await fetch(`/api/remote/lookup?q=${encodeURIComponent(`@${remoteQuery}`)}`, {
          credentials: 'include',
        });
        if (!res.ok || token !== mentionToken) return;
        const payload = (await res.json()) as {
          handle?: string;
          displayName?: string | null;
          avatarUrl?: string | null;
        };
        if (token !== mentionToken) return;
        const handle = (payload.handle ?? `@${remoteQuery}`).replace(/^@/, '');
        suggestions = [
          {
            key: `remote:${handle}`,
            kind: 'remote' as const,
            value: handle,
            display: payload.displayName || `@${handle}`,
            sub: `@${handle}`,
            avatarUrl: payload.avatarUrl ?? null,
          },
        ];
      } else if (at) {
        const res = await fetch(`/api/search?type=users&q=${encodeURIComponent(query)}&limit=5`, {
          credentials: 'include',
        });
        if (!res.ok || token !== mentionToken) return;
        const payload = (await res.json()) as Record<string, unknown>;
        if (token !== mentionToken) return;
        suggestions = (
          (payload.results ?? []) as Array<{ username: string; display_name: string; avatar_key: string | null }>
        ).map((u) => ({
          key: `user:${u.username}`,
          kind: 'user' as const,
          value: u.username,
          display: u.display_name || u.username,
          sub: `@${u.username}`,
          avatarKey: u.avatar_key,
        }));
      } else {
        const res = await fetch(`/api/tags/suggest?q=${encodeURIComponent(query)}&limit=5`);
        if (!res.ok || token !== mentionToken) return;
        const payload = (await res.json()) as Record<string, unknown>;
        if (token !== mentionToken) return;
        suggestions = ((payload.tags ?? []) as Array<{ tag: string; count: number }>).map((item) => ({
          key: `tag:${item.tag}`,
          kind: 'tag' as const,
          value: item.tag,
          display: `#${item.tag}`,
          sub: `${formatCount(item.count)} posts`,
        }));
      }
      activeSuggestion = 0;
      mentionOpen = suggestions.length > 0;
      positionDropdown();
    } catch {
      hideDropdown();
    }
  }, 200);
}

function positionDropdown(): void {
  if (!textarea || !mentionDropdown || !root) return;
  const header = textarea.parentElement;
  if (!header) return;
  const taRect = textarea.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  mentionDropdown.style.left = `${taRect.left - headerRect.left + 8}px`;
  mentionDropdown.style.top = `${taRect.bottom - headerRect.top + 4}px`;
}

function hideDropdown(): void {
  mentionToken++;
  mentionOpen = false;
  suggestions = [];
  if (mentionTimer) {
    clearTimeout(mentionTimer);
    mentionTimer = null;
  }
}

function selectSuggestion(index: number): void {
  const suggestion = suggestions[index];
  if (!suggestion || mentionStartPos < 0) return;
  const pos = textarea.selectionStart;
  const before = text.slice(0, mentionStartPos);
  const after = text.slice(pos);
  const prefix = suggestion.kind === 'tag' ? '#' : '@';
  textarea.value = `${before}${prefix}${suggestion.value} ${after}`;
  text = textarea.value;
  const newPos = mentionStartPos + suggestion.value.length + 2;
  textarea.setSelectionRange(newPos, newPos);
  hideDropdown();
  queueMicrotask(autosize);
  textarea.focus();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (mentionOpen) {
      hideDropdown();
      return;
    }
    clearFile();
    text = '';
    onCancel();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim() && !submitting) {
    e.preventDefault();
    void submit();
    return;
  }
  if (!mentionOpen) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectSuggestion(activeSuggestion);
  }
}

function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.includes('image')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        void selectFile(file);
      }
      break;
    }
  }
}

function openFilePicker(audio: boolean): void {
  fileInput.accept = audio ? '.mp3,.wav,.ogg,.m4a' : '.gif,.png,.jpg,.jpeg,.webm';
  fileInput.click();
}

async function selectFile(file: File): Promise<void> {
  if (file.size > maxFileBytes) {
    showToast(t('reply_composer.error_file_size'), true);
    clearFile();
    return;
  }
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
  ];
  const name = file.name.toLowerCase();
  const videoExt = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');
  if (!allowed.includes(file.type) && !videoExt) {
    showToast(t('reply_composer.error_file_type'), true);
    clearFile();
    return;
  }
  const dimError = await checkImageSizeLimit(file);
  if (dimError) {
    showToast(dimError, true);
    clearFile();
    return;
  }
  selectedFile = file;
  renderPreview();
}

function renderPreview(): void {
  previewHandle?.destroy();
  previewHandle = null;
  if (!previewHost) return;
  previewHost.replaceChildren();
  if (selectedFile) previewHandle = renderFilePreview(selectedFile, previewHost);
}

function clearFile(): void {
  selectedFile = null;
  if (fileInput) fileInput.value = '';
  renderPreview();
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  dropActive = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) void selectFile(file);
}

async function submit(): Promise<void> {
  if (submitting) return;
  const value = text.trim();
  if (!value) return;
  submitting = true;
  try {
    const reply = await submitReply(postId, selectedFile, value);
    markRecommendationProfileDirty();
    text = '';
    if (textarea) textarea.value = '';
    clearFile();
    onReplyCreated(reply);
  } catch (error) {
    const isAuth = error instanceof AuthRequiredError;
    const message = isAuth
      ? t('reply_composer.error_auth_required')
      : error instanceof Error
        ? error.message
        : t('composer.error_create_failed');
    showToast(message, true);
    if (isAuth) {
      showSignInPrompt(
        'reply',
        () => {
          void navigate('/login');
        },
        () => {
          void navigate('/register');
        },
      );
    }
  } finally {
    submitting = false;
  }
}

export function focus(): void {
  textarea?.focus();
}

export function insertText(value: string): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + value + after;
  text = textarea.value;
  const pos = start + value.length;
  textarea.setSelectionRange(pos, pos);
  queueMicrotask(autosize);
  textarea.focus();
}
</script>

<div
  bind:this={root}
  class="reply-composer"
  class:reply-composer--dragover={dropActive}
  data-meter-state={char.state}
  style="--fx-progress: {char.ratio.toFixed(3)};"
  ondragover={(e) => { e.preventDefault(); dropActive = true; }}
  ondragleave={() => (dropActive = false)}
  ondrop={onDrop}
  role="group"
>
  <div class="reply-composer-body">
    <div class="reply-composer-header" style="position: relative;">
      <div
        bind:this={avatarEl}
        class="reply-composer-avatar"
        onclick={(e) => {
          e.stopPropagation();
          const user = activeUser();
          if (!user) return;
          void navigate(`/profile/${user.username}`);
        }}
        role="button"
        tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
      ></div>
      <textarea
        bind:this={textarea}
        class="reply-composer-textarea"
        placeholder={t('reply_composer.placeholder')}
        maxlength={POST_CHAR_LIMIT}
        value={text}
        oninput={onInput}
        onkeydown={onKeydown}
        onpaste={onPaste}
      ></textarea>
      <div class="reply-composer-remote-hint" style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">{t('composer.mention_remote_hint')}</div>
      {#if mentionOpen}
        <div bind:this={mentionDropdown} class="mention-dropdown" style="display:block;">
          {#each suggestions as suggestion, i (suggestion.key)}
            <div
              class="mention-item"
              data-value={suggestion.value}
              class:mention-item--active={i === activeSuggestion}
              style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;"
              onclick={() => selectSuggestion(i)}
              onmouseenter={() => (activeSuggestion = i)}
              role="button"
              tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter') selectSuggestion(i); }}
            >
              {#if suggestion.kind === 'tag'}
                <span class="mention-avatar" style="width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:bold;">#</span>
              {:else if suggestion.kind === 'remote' && suggestion.avatarUrl && isAbsoluteMediaUrl(suggestion.avatarUrl)}
                <img class="mention-avatar" src={suggestion.avatarUrl} alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;" />
              {:else if suggestion.avatarKey}
                <span class="mention-avatar" style="width:24px;height:24px;border-radius:50%;background-image:url({nativeApiHref(`/api/images/${suggestion.avatarKey}`)});background-size:cover;background-position:center;flex-shrink:0;"></span>
              {:else}
                <span class="mention-avatar" style="width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:bold;">{suggestion.value.charAt(0).toUpperCase()}</span>
              {/if}
              <span style="display:flex;flex-direction:column;">
                <span style="color:var(--text-primary);font-size:0.875rem;font-weight:500;">{suggestion.display}</span>
                <span style="color:var(--text-muted);font-size:0.75rem;">{suggestion.sub}</span>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="composer-progress" aria-hidden="true"><span class="composer-progress-fill"></span></div>

    {#if dropActive}
      <div class="reply-composer-file-dropzone" style="display:flex;">
        <span class="dropzone-text">{t('reply_composer.file_hint')}</span>
      </div>
    {/if}

    <div class="reply-composer-divider"></div>

    <div class="reply-composer-footer">
      <div class="reply-composer-actions">
        <input
          bind:this={fileInput}
          type="file"
          class="reply-composer-file-input"
          accept=".gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm"
          onchange={(e) => { const file = e.currentTarget.files?.[0]; if (file) void selectFile(file); }}
        />
        <div class="reply-composer-attach-group">
          <button class="reply-composer-file-button reply-composer-file-button--image" type="button" title={t('composer.attach_image_video')} onclick={() => openFilePicker(false)}>
            <span class="action-icon" data-icon="image-video"></span>
          </button>
          <button class="reply-composer-file-button reply-composer-file-button--audio" type="button" title={t('composer.attach_audio')} onclick={() => openFilePicker(true)}>
            <span class="action-icon" data-icon="audio"></span>
          </button>
        </div>
        <span class="composer-meter" data-state={char.state} data-empty={char.empty}>
          <span class="composer-char-count reply-composer-char-count">{text.length}/200</span>
        </span>
      </div>
      <div class="reply-composer-buttons">
        <button
          class="reply-composer-cancel"
          type="button"
          onclick={() => { text = ''; clearFile(); onCancel(); }}
        >{t('reply_composer.cancel')}</button>
        <button
          class="reply-composer-submit"
          type="button"
          disabled={!text.trim() || submitting}
          data-state={submitting ? 'sending' : 'idle'}
          onclick={() => void submit()}
        >{submitting ? t('reply_composer.replying') : t('reply_composer.reply')}</button>
      </div>
    </div>

    <div class="reply-composer-file-preview" style="display:{selectedFile ? 'block' : 'none'};">
      <div class="file-info">
        <span class="file-name"></span>
        <button class="file-remove" type="button" onclick={clearFile}><span class="action-icon" data-icon="close"></span></button>
      </div>
      <div bind:this={previewHost}></div>
    </div>
  </div>
</div>
