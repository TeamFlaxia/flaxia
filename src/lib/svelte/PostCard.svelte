<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { canUsePostColors } from '../../../shared/entitlements.ts';
import { stripPostColors } from '../../../shared/post-colors.ts';
import { stripMediaCues } from '../../../shared/post-cues.ts';
import { type Post, PostCardMode, type QuotedPost, type ReactionSummary } from '../../../shared/types/post.ts';
import { showSignInPrompt } from '../../components/SignInPrompt.ts';
import { t } from '../i18n.ts';
import { impressionTracker } from '../impression-tracker.ts';
import { pauseMediaIn } from '../media-mute.ts';
import { navigate } from '../navigation.ts';
import {
  confirmDelete,
  mountActions,
  mountLinkPreview,
  mountMenu,
  mountMenuButton,
  mountPostText,
  mountReply,
  mountStage,
  openCounterNotice,
  openGameUpdate,
  openReport,
  openShare,
  openVersionHistory,
  type StageHandle,
  unmountActions,
  unmountMenu,
  unmountPostText,
} from '../post/card-adapters.ts';
import { openPostModal } from '../post-modal.ts';
import { getShowNsfw } from '../settings.ts';
import { showToast } from '../toast.ts';
import { markRecommendationProfileDirty } from '../vault/recommendation-profile.ts';
import PollWidget from './PollWidget.svelte';
import PostHeader from './PostHeader.svelte';
import QuotedPostCard from './QuotedPostCard.svelte';

interface Props {
  post: Post;
  sandboxOrigin: string;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
  initialMode?: PostCardMode;
  depth?: number;
  postIndex?: number;
  enablePostRefs?: boolean;
  disableReply?: boolean;
  disableReplyComposer?: boolean;
  disableNavigation?: boolean;
  showPinOption?: boolean;
  pinned?: boolean;
  onDelete?: (postId: string) => void;
  onTogglePin?: (postId: string) => void;
  /** Notified after the inline reply composer submits successfully. */
  onReplyCreated?: (reply: Post) => void;
  /** Notified when the reply action is toggled (shells own their composer). */
  onReplyToggle?: (postId: string) => void;
  /** Reply views hide the leading `>>N` reference from the body. */
  stripLeadingPostRef?: boolean;
}
let props: Props = $props();

let root: HTMLDivElement;
let textHost: HTMLDivElement;
let linkHost: HTMLDivElement;
let stageHost: HTMLDivElement;
let actionsHost: HTMLDivElement;
let replyHost: HTMLDivElement;
let headerSlot: HTMLDivElement;
let menuHost: HTMLDivElement;
let pollHost: HTMLDivElement;
let quoteHost: HTMLDivElement;

let freshCount = $state(props.post.fresh_count ?? 0);
let reloadCount = $state(props.post.reload_count ?? 0);
let bookmarkCount = $state(props.post.bookmark_count ?? 0);
let replyCount = $state(props.post.reply_count ?? 0);
let impressions = $state(props.post.impressions ?? 0);
let freshed = $state(Boolean(props.post.is_freshed));
let reloaded = $state(Boolean(props.post.is_reloaded));
let bookmarked = $state(Boolean(props.post.is_bookmarked));
let reactions = $state<ReactionSummary[]>(props.post.reactions ?? []);
let replyOpen = $state(false);
let showNsfw = $state(false);
let editing = $state(false);
let editText = $state('');
let saving = $state(false);
let menuOpen = $state(false);
let versionId: string | null = null;
let stage: StageHandle | null = null;
let stageMode = $state<PostCardMode>(props.initialMode ?? PostCardMode.PREVIEW);
let replyComposer: { getElement: () => HTMLElement; focus: () => void; destroy: () => void } | null = null;
let impressionSent = false;

const hasMedia = Boolean(
  props.post.gif_key ||
    props.post.payload_key ||
    props.post.swf_key ||
    props.post.thumbnail_key ||
    (props.post.attachments && props.post.attachments.length > 0),
);
const textLength = (props.post.text ?? '').trim().length;
const isLongText = !hasMedia && textLength > 90;
function parseHashtags(value: string): string[] {
  return (value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

let currentText = $state(props.post.text ?? '');
let currentHashtags = $state<string[]>(parseHashtags(props.post.hashtags));
let currentMentions = $state(props.post.mentions);

const hashtags = $derived(currentHashtags);
const isNsfw = $derived(hashtags.some((tag) => tag.toLowerCase() === 'nsfw' || tag.toLowerCase() === 'r18'));
const displayText = $derived(
  props.stripLeadingPostRef ? currentText.replace(/^\s*>>\d+\s*/g, '').trimStart() : currentText,
);
const plainText = $derived(
  canUsePostColors({ badge_type: props.post.badge_type }) ? stripPostColors(displayText) : stripMediaCues(displayText),
);

function actionConfig() {
  return {
    postId: props.post.id,
    freshCount,
    reloadCount,
    bookmarkCount,
    replyCount,
    impressions,
    isFreshed: freshed,
    isReloaded: reloaded,
    isBookmarked: bookmarked,
    reactions,
    depth: props.depth ?? props.post.depth,
    onFreshToggle: () => void toggleFresh(),
    onReloadToggle: () => void toggleReload(),
    onBookmarkToggle: () => void toggleBookmark(),
    onReplyToggle: toggleReply,
    onShare: () => openShare(props.post, handleQuote),
    onQuote: handleQuote,
    onReactionToggle: (emoji: string) => void toggleReaction(emoji),
  };
}

function refreshActions(): void {
  if (!actionsHost) return;
  mountActions(actionsHost, actionConfig() as never);
}

function requireAuth(action: 'reply' | 'post' | 'fresh'): boolean {
  if (props.currentUser) return true;
  showSignInPrompt(
    action,
    () => void navigate('/login'),
    () => void navigate('/register'),
  );
  return false;
}

function broadcast(update: Partial<Post>): void {
  window.dispatchEvent(
    new CustomEvent('postUpdated', {
      detail: {
        postId: props.post.id,
        isFreshed: update.is_freshed,
        freshCount: update.fresh_count,
        isReloaded: update.is_reloaded,
        reloadCount: update.reload_count,
        isBookmarked: update.is_bookmarked,
        bookmarkCount: update.bookmark_count,
        replyCount: update.reply_count,
        reactions: update.reactions,
        text: update.text,
        hashtags: update.hashtags,
        mentions: update.mentions,
      },
    }),
  );
}

async function toggleFresh(): Promise<void> {
  if (!requireAuth('fresh')) return;
  const beforeFreshed = freshed;
  const beforeCount = freshCount;
  freshed = !freshed;
  freshCount = Math.max(0, freshCount + (freshed ? 1 : -1));
  refreshActions();
  try {
    const res = await fetch(`/api/posts/${props.post.id}/fresh`, { method: 'POST', credentials: 'include' });
    // The counts were already moved optimistically; revert through catch().
    if (!res.ok) throw new Error(`fresh failed: ${res.status}`);
    const data = (await res.json()) as { fresh_count: number; is_freshed: boolean };
    freshCount = data.fresh_count;
    freshed = data.is_freshed;
    markRecommendationProfileDirty();
    refreshActions();
    broadcast({ is_freshed: freshed, fresh_count: freshCount });
  } catch (e) {
    freshed = beforeFreshed;
    freshCount = beforeCount;
    refreshActions();
    console.error('fresh failed', e);
  }
}

async function toggleReload(): Promise<void> {
  if (!requireAuth('fresh')) return;
  try {
    const res = await fetch(`/api/posts/${props.post.id}/reload`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return;
    const data = (await res.json()) as { reload_count: number; is_reloaded: boolean };
    reloadCount = data.reload_count;
    reloaded = data.is_reloaded;
    markRecommendationProfileDirty();
    refreshActions();
    broadcast({ is_reloaded: reloaded, reload_count: reloadCount });
  } catch (e) {
    console.error('reload failed', e);
  }
}

async function toggleBookmark(): Promise<void> {
  if (!requireAuth('post')) return;
  try {
    const res = await fetch(`/api/posts/${props.post.id}/bookmark`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return;
    const data = (await res.json()) as { bookmark_count: number; is_bookmarked: boolean };
    bookmarkCount = data.bookmark_count;
    bookmarked = data.is_bookmarked;
    refreshActions();
    broadcast({ is_bookmarked: bookmarked, bookmark_count: bookmarkCount });
  } catch (e) {
    console.error('bookmark failed', e);
  }
}

async function toggleReaction(emoji: string): Promise<void> {
  if (!requireAuth('reaction' as 'fresh')) return;
  const previous = reactions;
  const idx = previous.findIndex((r) => r.emoji === emoji);
  const optimistic = previous.map((r) => ({ ...r }));
  if (idx >= 0) {
    const r = optimistic[idx];
    r.count += r.reacted ? -1 : 1;
    r.reacted = !r.reacted;
    if (r.count <= 0) optimistic.splice(idx, 1);
  } else {
    optimistic.push({ emoji, count: 1, reacted: true });
  }
  reactions = optimistic;
  refreshActions();
  try {
    const res = await fetch(`/api/posts/${props.post.id}/reactions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    if (!res.ok) throw new Error(`reaction failed: ${res.status}`);
    const data = (await res.json()) as { reactions?: ReactionSummary[] };
    if (data.reactions) reactions = data.reactions;
    refreshActions();
    broadcast({ reactions });
  } catch (e) {
    reactions = previous;
    refreshActions();
    console.error('reaction failed', e);
  }
}

function toggleReply(): void {
  if (props.disableReply) return;
  if (!requireAuth('reply')) return;
  replyOpen = !replyOpen;
  // Thread/timeline shells open their own composer on this bubbling event.
  root?.dispatchEvent(new CustomEvent('replyToggle', { detail: { postId: props.post.id }, bubbles: true }));
  props.onReplyToggle?.(props.post.id);
  if (replyOpen) queueMicrotask(() => replyComposer?.focus());
}

function handleQuote(): void {
  if (!requireAuth('post')) return;
  const p = props.post;
  openPostModal({
    currentUser: props.currentUser ?? null,
    onPostCreated: (post) => void navigate(`/thread/${post.id}`),
    quotedPost: {
      id: p.id,
      user_id: p.user_id,
      username: p.username,
      display_name: p.display_name,
      avatar_key: p.avatar_key,
      avatar_url: p.avatar_url,
      actor_id: p.actor_id,
      is_remote: p.is_remote,
      badge_type: p.badge_type,
      name_color: p.name_color,
      text: p.text,
      hashtags: p.hashtags,
      gif_key: p.gif_key,
      payload_key: p.payload_key,
      swf_key: p.swf_key,
      thumbnail_key: p.thumbnail_key,
      created_at: p.created_at,
    },
  });
}

async function blockUser(): Promise<void> {
  const username = props.post.username;
  try {
    const response = await fetch(`/api/users/${username}/block`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || 'Failed to block user');
    }
    showToast(t('post.blocked', { username }));
    if (root) {
      root.style.transition = 'opacity 0.3s, transform 0.3s';
      root.style.opacity = '0';
      root.style.transform = 'translateX(-100%)';
    }
    props.onDelete?.(props.post.id);
  } catch (error) {
    console.error('Block user error:', error);
    showToast(t('post.block_failed'), true);
  }
}

function onPostClick(e: MouseEvent): void {
  if (props.disableNavigation) return;
  const target = e.target as HTMLElement;
  if (
    target.closest(
      'button, input, textarea, a, .poll-option, .video-player, .audio-player, .image-preview, .media-carousel-dots, .media-carousel-track',
    )
  )
    return;
  if (window.getSelection()?.toString()) return;
  void navigate(`/thread/${props.post.id}`, { state: { postId: props.post.id } });
}

function handleReplyCreated(reply: Post): void {
  replyCount += 1;
  replyOpen = false;
  refreshActions();
  broadcast({ reply_count: replyCount });
  props.onReplyCreated?.(reply);
}

function toggleMenu(): void {
  if (!menuHost) return;
  if (menuOpen) {
    unmountMenu(menuHost);
    menuOpen = false;
    mountMenuButton(menuHost, toggleMenu);
    return;
  }
  const isOwn = props.currentUser?.username === props.post.username;
  const options = {
    isOwnPost: isOwn,
    isRemote: Boolean(props.post.is_remote),
    showPinOption: props.showPinOption,
    pinned: props.pinned,
    payloadKey: props.post.payload_key,
    currentUser: props.currentUser as never,
    actions: {
      onVersionHistory: () => openVersionHistory(props.post, props.sandboxOrigin, versionId, playVersion),
      onTogglePin: () => props.onTogglePin?.(props.post.id),
      onCounterNotice: () => openCounterNotice(props.post),
      onEdit: startEdit,
      onUpdate: () => openGameUpdate(props.post, props.sandboxOrigin, () => playVersion(null)),
      onDelete: deletePost,
      onBlock: () => void blockUser(),
      onReport: () => openReport(props.post),
    },
  };
  mountMenu(menuHost, options as never, () => {
    menuOpen = false;
    // mountMenu clears the host on close, so restore the trigger button.
    mountMenuButton(menuHost, toggleMenu);
  });
  menuOpen = true;
}

async function deletePost(): Promise<void> {
  if (!(await confirmDelete())) return;
  try {
    const res = await fetch(`/api/posts/${props.post.id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) props.onDelete?.(props.post.id);
    else showToast(t('post.delete_failed'), true);
  } catch {
    showToast(t('post.delete_failed'), true);
  }
}

function startEdit(): void {
  // Close the menu before showing the editor; otherwise the dropdown keeps
  // intercepting pointer events over the textarea and Save button.
  if (menuOpen) toggleMenu();
  editText = plainText;
  editing = true;
}

async function saveEdit(): Promise<void> {
  if (saving) return;
  const text = editText.trim();
  if (!text) return;
  saving = true;
  try {
    const res = await fetch(`/api/posts/${props.post.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('save failed');
    const data = (await res.json()) as { post?: Post };
    const updated = data.post;
    editing = false;
    if (updated) {
      updatePost({ text: updated.text, hashtags: updated.hashtags, mentions: updated.mentions });
      broadcast({ text: updated.text, hashtags: updated.hashtags, mentions: updated.mentions });
    } else {
      updatePost({ text });
    }
  } catch {
    showToast(t('post.edit_failed'), true);
  } finally {
    saving = false;
  }
}

function playVersion(id: string | null): void {
  versionId = id;
  if (!stageHost) return;
  stageMode = PostCardMode.EXECUTING;
  stage?.destroy();
  stage = mountStage(stageHost, {
    post: props.post,
    mode: stageMode,
    sandboxOrigin: props.sandboxOrigin,
    versionId: id ?? undefined,
    onModeChange: handleStageModeChange,
  });
}

function handleStageModeChange(mode: PostCardMode): void {
  stageMode = mode;
  stage?.update(props.post, mode, versionId ?? undefined);
}

export function updatePost(next: Partial<Post>): void {
  if (next.text !== undefined) {
    currentText = next.text;
    if (next.hashtags !== undefined) currentHashtags = parseHashtags(next.hashtags);
    if (next.mentions !== undefined) currentMentions = next.mentions;
    queueMicrotask(() => {
      void mountPostText(textHost, {
        text: displayText,
        mentions: currentMentions,
        enablePostRefs: props.enablePostRefs,
        badgeType: props.post.badge_type,
      });
      if (props.currentUser) mountLinkPreview(linkHost, currentText);
    });
  } else if (next.hashtags !== undefined) {
    currentHashtags = parseHashtags(next.hashtags);
  }
  if (next.reply_count !== undefined) replyCount = next.reply_count;
  if (next.fresh_count !== undefined) freshCount = next.fresh_count;
  if (next.reload_count !== undefined) reloadCount = next.reload_count;
  if (next.bookmark_count !== undefined) bookmarkCount = next.bookmark_count;
  if (next.impressions !== undefined) impressions = next.impressions;
  if (next.is_freshed !== undefined) freshed = next.is_freshed;
  if (next.is_reloaded !== undefined) reloaded = next.is_reloaded;
  if (next.is_bookmarked !== undefined) bookmarked = next.is_bookmarked;
  if (next.reactions !== undefined) reactions = next.reactions;
  queueMicrotask(refreshActions);
}

export function handleReplyTogglePublic(): void {
  toggleReply();
}

onMount(() => {
  void mountPostText(textHost, {
    text: displayText,
    mentions: props.post.mentions,
    enablePostRefs: props.enablePostRefs,
    badgeType: props.post.badge_type,
  });
  if (props.currentUser) void mountLinkPreview(linkHost, props.post.text);
  if (props.post.poll) {
    /* PollWidget renders from props below */
  }
  if (hasMedia)
    stage = mountStage(stageHost, {
      post: props.post,
      mode: stageMode,
      sandboxOrigin: props.sandboxOrigin,
      onModeChange: handleStageModeChange,
    });
  if (!props.disableReply && !props.disableReplyComposer) {
    replyComposer = mountReply(replyHost, {
      postId: props.post.id,
      sandboxOrigin: props.sandboxOrigin,
      onReplyCreated: handleReplyCreated,
      onCancel: () => (replyOpen = false),
      prefillText: props.postIndex !== undefined ? `>>${props.postIndex} ` : undefined,
      currentUser: props.currentUser ?? undefined,
    });
  }
  refreshActions();
  mountMenuButton(menuHost, toggleMenu);

  // Every mounted card listens for the same event, so a card in the feed and
  // the same post in a thread/bookmark list stay in sync without a card map.
  const onPostUpdated = ((e: Event) => {
    const detail = (e as CustomEvent<Record<string, unknown>>).detail;
    if (!detail || detail.postId !== props.post.id) return;
    updatePost({
      is_freshed: detail.isFreshed as boolean | undefined,
      fresh_count: detail.freshCount as number | undefined,
      is_reloaded: detail.isReloaded as boolean | undefined,
      reload_count: detail.reloadCount as number | undefined,
      is_bookmarked: detail.isBookmarked as boolean | undefined,
      bookmark_count: detail.bookmarkCount as number | undefined,
      reply_count: detail.replyCount as number | undefined,
      reactions: detail.reactions as ReactionSummary[] | undefined,
      text: detail.text as string | undefined,
      hashtags: detail.hashtags as string | undefined,
      mentions: detail.mentions as string | undefined,
    });
  }) as EventListener;
  window.addEventListener('postUpdated', onPostUpdated);
  onDestroy(() => window.removeEventListener('postUpdated', onPostUpdated));

  if (!props.disableNavigation && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !impressionSent) {
          impressionSent = true;
          impressionTracker.trackImpression(props.post.id);
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(root);
    onDestroy(() => observer.disconnect());
  }
});

onDestroy(() => {
  stage?.destroy();
  replyComposer?.destroy();
  unmountActions(actionsHost);
  unmountMenu(menuHost);
  unmountPostText(textHost);
  pauseMediaIn(root);
});
</script>

<article
  bind:this={root}
  class="post-card {hasMedia ? 'post-card--media' : 'post-card--text'}{isLongText ? ' post-card--long' : ''}{props.disableNavigation ? ' post-card--static' : ''}"
  data-post-id={props.post.id}
  data-post-index={props.postIndex}
  onclick={onPostClick}
>
  <div class="post-card-header">
    {#if props.postIndex !== undefined}<span class="post-index">{props.postIndex}</span>{/if}
    <div bind:this={headerSlot} class="post-header-slot">
      <PostHeader
        username={props.post.username}
        display_name={props.post.display_name}
        avatar_key={props.post.avatar_key}
        avatar_url={props.post.avatar_url}
        profile_url={props.post.actor_id}
        badge_type={props.post.badge_type}
        name_color={props.post.name_color}
        equipped_title_id={props.post.equipped_title_id}
        title_name={props.post.title_name}
        title_name_ja={props.post.title_name_ja}
        title_description={props.post.title_description}
        title_description_ja={props.post.title_description_ja}
        title_icon={props.post.title_icon}
        createdAt={props.post.created_at}
        editedAt={props.post.edited_at}
      />
    </div>
    <div class="post-header-actions">
      <span class="post-ai-index" hidden={props.post.ai_indexed !== true}>✓</span>
      <div bind:this={menuHost}></div>
    </div>
  </div>

  {#if editing}
    <div class="edit-container">
      <textarea class="edit-textarea" maxlength="200" bind:value={editText}></textarea>
      <div class="edit-actions">
        <span class="edit-count">{editText.length}/200</span>
        <button type="button" class="edit-cancel" onclick={() => (editing = false)}>{t('post.edit_cancel')}</button>
        <button type="button" class="edit-save" disabled={saving} onclick={() => void saveEdit()}>
          {t('post.edit_save')}
        </button>
      </div>
    </div>
  {/if}
  <!-- Kept mounted while editing so Cancel does not drop the rendered text. -->
  <div class="post-text-wrap" hidden={editing}>
    <div bind:this={textHost}></div>
  </div>

  {#if props.post.poll}
    <div bind:this={pollHost}><PollWidget {...props.post.poll} /></div>
  {/if}
  <div bind:this={linkHost} class="post-link-preview-container"></div>

  {#if props.post.quoted_post_id}
    <div bind:this={quoteHost}>
      <QuotedPostCard
        quoted={props.post.quoted_post ?? null}
        disableNavigation={props.disableNavigation}
        onNavigateToThread={(id) => void navigate(`/thread/${id}`, { state: { postId: id } })}
      />
    </div>
  {/if}

  {#if hasMedia}<div bind:this={stageHost}></div>{/if}
  {#if !props.disableReply}<div bind:this={actionsHost}></div>{/if}
  <div bind:this={replyHost} style="display:{replyOpen ? 'block' : 'none'};"></div>

  {#if isNsfw && getShowNsfw() && !showNsfw}
    <div class="nsfw-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:5;">
      <div style="font-size:1.5rem;">⚠️</div>
      <p>{t('post.nsfw_warning')}</p>
      <button type="button" onclick={(e) => { e.stopPropagation(); showNsfw = true; }}>{t('post.nsfw_show')}</button>
    </div>
  {/if}
</article>


<style>
  .edit-container {
    margin: 0.5rem 0;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .edit-textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 4.5rem;
    padding: 0.5rem;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font: inherit;
    line-height: 1.5;
  }

  .edit-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .edit-count {
    margin-right: auto;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .edit-cancel,
  .edit-save {
    padding: 0.35rem 0.85rem;
    border-radius: 9999px;
    font-size: 0.875rem;
    cursor: pointer;
  }

  .edit-cancel {
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .edit-save {
    border: 0;
    background: var(--accent);
    color: var(--on-accent);
  }

  .edit-save:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
