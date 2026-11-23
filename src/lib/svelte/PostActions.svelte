<script module lang="ts">
let nextActionDropdownId = 0;

export function nextPostActionsDropdownId(): number {
  return ++nextActionDropdownId;
}
</script>

<script lang="ts">
import { tick } from 'svelte';
import type { PostActionsProps } from '../../../shared/types/post.ts';
import { openStampPicker } from '../../components/StampPicker.ts';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import type { IconName } from '../icons.ts';
import { iconHtml } from '../post/icon-html.ts';

type ActionPop = 'fresh' | 'bookmark' | 'reload';

type ActionButtonType = 'fresh' | 'bookmark' | 'reply' | 'reload' | 'share' | 'impressions' | 'quote';

interface Props extends PostActionsProps {
  /** Which toggle just turned ON — plays a 160ms spring pop once. */
  popAction?: ActionPop;
  /** Emoji of the reaction that just turned ON — pops that chip. */
  popReaction?: string;
}

let props: Props = $props();

const POP_DURATION_MS = 160;

let triggerEl = $state<HTMLButtonElement>();
let menuEl = $state<HTMLDivElement>();
let dropdownOpen = $state(false);
let menuLeft = $state(0);
let menuTop = $state(0);
let poppingAction = $state<ActionPop | null>(null);
let poppingReaction = $state<string | null>(null);

const dropdownId = `post-action-dropdown-${nextPostActionsDropdownId()}`;

const menuActions = $derived<Array<{ key: string; label: string; iconName: IconName; onClick: () => void }>>([
  { key: 'reload', label: t('post_actions.reload'), iconName: 'reload', onClick: props.onReloadToggle },
  { key: 'quote', label: t('post_actions.quote'), iconName: 'quote', onClick: () => props.onQuote?.() },
  { key: 'share', label: t('post_actions.share'), iconName: 'share', onClick: () => props.onShare?.() },
]);

$effect(() => {
  const action = props.popAction;
  if (!action) return;
  poppingAction = action;
  const timer = window.setTimeout(() => {
    if (poppingAction === action) poppingAction = null;
  }, POP_DURATION_MS);
  return () => {
    window.clearTimeout(timer);
  };
});

$effect(() => {
  const reaction = props.popReaction;
  if (!reaction) return;
  poppingReaction = reaction;
  const timer = window.setTimeout(() => {
    if (poppingReaction === reaction) poppingReaction = null;
  }, POP_DURATION_MS);
  return () => {
    window.clearTimeout(timer);
  };
});

function getIconNameForType(type: ActionButtonType): IconName {
  switch (type) {
    case 'fresh':
      return 'fresh';
    case 'bookmark':
      return 'bookmark';
    case 'reply':
      return 'reply';
    case 'reload':
      return 'reload';
    case 'share':
      return 'share';
    case 'impressions':
      return 'impressions';
    case 'quote':
      return 'quote';
    default:
      return 'share';
  }
}

function buttonClass(type: ActionButtonType, active = false, extra = ''): string {
  return `action-button action-button--${type}${active ? ' action-button--active' : ''}${extra ? ` ${extra}` : ''}`;
}

function buttonLabel(type: ActionButtonType): string {
  return type === 'reload' ? t('post_actions.reload') : t('post_actions.aria_label', { type });
}

function toggleReaction(emoji: string): void {
  props.onReactionToggle(emoji);
}

function positionDropdown(): void {
  if (!triggerEl || !menuEl) return;

  const triggerRect = triggerEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
  menuLeft = Math.min(Math.max(margin, triggerRect.left), maxLeft);
  const openAbove = triggerRect.top >= menuRect.height + margin * 2;
  const desiredTop = openAbove ? triggerRect.top - menuRect.height - 2 : triggerRect.bottom + 2;
  menuTop = Math.min(Math.max(margin, desiredTop), maxTop);
}

async function toggleDropdown(event: MouseEvent): Promise<void> {
  event.stopPropagation();
  if (dropdownOpen) {
    dropdownOpen = false;
    return;
  }
  dropdownOpen = true;
  await tick();
  positionDropdown();
}

function closeDropdown(focusTrigger = false): void {
  dropdownOpen = false;
  if (focusTrigger) triggerEl?.focus();
}

function runMenuAction(action: { onClick: () => void }): void {
  closeDropdown();
  action.onClick();
}

$effect(() => {
  if (!dropdownOpen) return;

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (triggerEl?.contains(target) || menuEl?.contains(target)) return;
    closeDropdown();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeDropdown(true);
  };

  const onReflow = () => positionDropdown();

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
  };
});
</script>

<div class="post-actions">
  <div class="post-actions-left">
    <button
      type="button"
      class={buttonClass('fresh', props.isFreshed, poppingAction === 'fresh' ? 'is-popping' : '')}
      aria-label={buttonLabel('fresh')}
      title={buttonLabel('fresh')}
      aria-pressed={String(props.isFreshed)}
      onclick={() => props.onFreshToggle()}
    >
      <span class="action-icon">{@html iconHtml(getIconNameForType('fresh'))}</span>
      <span class="action-count">{formatCount(props.freshCount)}</span>
    </button>

    <button
      type="button"
      class={buttonClass('reply')}
      aria-label={buttonLabel('reply')}
      title={buttonLabel('reply')}
      onclick={() => props.onReplyToggle()}
    >
      <span class="action-icon">{@html iconHtml(getIconNameForType('reply'))}</span>
      <span class="action-count">{formatCount(props.replyCount)}</span>
    </button>

    <div class="post-action-dropdown">
      <button
        bind:this={triggerEl}
        type="button"
        class={buttonClass('reload', props.isReloaded, poppingAction === 'reload' ? 'is-popping' : '')}
        aria-label={t('post_actions.more_actions')}
        title={t('post_actions.more_actions')}
        aria-expanded={dropdownOpen}
        aria-controls={dropdownId}
        onclick={toggleDropdown}
      >
        <span class="action-icon">{@html iconHtml(getIconNameForType('reload'))}</span>
        <span class="action-count">{formatCount(props.reloadCount)}</span>
      </button>

      {#if dropdownOpen}
        <div
          bind:this={menuEl}
          id={dropdownId}
          class="post-action-dropdown-menu"
          role="group"
          aria-label={t('post_actions.more_actions')}
          style="left: {menuLeft}px; top: {menuTop}px;"
        >
          {#each menuActions as action (action.key)}
            <button
              type="button"
              class="post-action-dropdown-item"
              style="display: flex; align-items: center; gap: 0.5rem;"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(action);
              }}
            >
              <span class="post-action-dropdown-icon">{@html iconHtml(action.iconName)}</span>
              <span class="post-action-dropdown-label">{action.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="post-actions-right">
    <button
      type="button"
      class={buttonClass('bookmark', props.isBookmarked, poppingAction === 'bookmark' ? 'is-popping' : '')}
      aria-label={buttonLabel('bookmark')}
      title={buttonLabel('bookmark')}
      aria-pressed={String(props.isBookmarked)}
      onclick={() => props.onBookmarkToggle()}
    >
      <span class="action-icon">{@html iconHtml(getIconNameForType('bookmark'))}</span>
    </button>

    <button
      type="button"
      class={buttonClass('impressions')}
      aria-label={buttonLabel('impressions')}
      title={buttonLabel('impressions')}
      onclick={(event) => event.stopPropagation()}
    >
      <span class="action-icon">{@html iconHtml(getIconNameForType('impressions'))}</span>
      <span class="action-count">{formatCount(props.impressions)}</span>
    </button>
  </div>

  <div class="post-reactions">
    {#each props.reactions as reaction (reaction.emoji)}
      <button
        type="button"
        class="post-reaction-chip"
        class:reacted={reaction.reacted}
        class:is-popping={poppingReaction === reaction.emoji}
        data-emoji={reaction.emoji}
        aria-pressed={String(reaction.reacted)}
        onclick={(event) => {
          event.stopPropagation();
          toggleReaction(reaction.emoji);
        }}
      >
        <span class="post-reaction-emoji">
          {#if reaction.stamp_url}
            <img
              src={reaction.stamp_url}
              alt={reaction.emoji}
              style="width: 1.2em; height: 1.2em; vertical-align: -0.2em;"
            />
          {:else}
            {reaction.emoji}
          {/if}
        </span>
        <span class="post-reaction-count">{reaction.count}</span>
      </button>
    {/each}

    <button
      type="button"
      class="post-reaction-add"
      aria-label={t('post.reactions_add')}
      title={t('post.reactions_add')}
      onclick={(event) => {
        event.stopPropagation();
        const anchor = event.currentTarget as HTMLButtonElement;
        openStampPicker(anchor, { onSelect: (emoji: string) => toggleReaction(emoji) });
      }}
    >
      <span class="post-reaction-add-icon">{@html iconHtml('smile-plus')}</span>
    </button>
  </div>
</div>
