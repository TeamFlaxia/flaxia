import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { createMenuItem } from '../lib/modal-overlay.js';
import { each, html, legacy, mount } from '../lib/render/index.ts';
import { type PostActionsProps, type ReactionSummary } from '../types/post.js';
import { openStampPicker } from './StampPicker.js';

let nextActionDropdownId = 0;

/** Toggle actions that get a one-shot pop when they turn ON. */
export type ActionPop = 'fresh' | 'bookmark' | 'reload';

type PostActionsOptions = PostActionsProps & {
  /** Which toggle just turned ON — plays a 320ms spring pop once. */
  popAction?: ActionPop;
  /** Emoji of the reaction that just turned ON — pops that chip. */
  popReaction?: string;
};

/** How long the transient pop class lives before it is cleaned up. */
const POP_DURATION_MS = 160;

/**
 * Adds `.is-popping` for one animation cycle, then removes it.
 * Keyed on the class so both pointer and keyboard (Enter/Space fire
 * a click on buttons) share the same path.
 */
function playOneShotPop(element: HTMLElement): void {
  // The class is set before the node is attached (PostCard inserts the
  // rebuilt action row right after this factory returns), so the CSS
  // animation starts on first style resolution. No rAF hop here: the
  // fetch can resolve fast enough to re-render the row and detach the
  // element before a frame callback would have run.
  element.classList.add('is-popping');
  window.setTimeout(() => element.classList.remove('is-popping'), POP_DURATION_MS);
}

export function createPostActions(props: PostActionsOptions): HTMLElement {
  const container = document.createElement('div');
  container.className = 'post-actions';

  const reloadActionsDropdown = createReloadActionsDropdown(props);
  const reactionsRow = createReactionsRow(props.reactions, props.onReactionToggle, props.popReaction);

  mount(
    container,
    () => html`
      <div class="post-actions-left">
        ${actionButtonTemplate({
          type: 'fresh',
          count: formatCount(props.freshCount),
          isActive: props.isFreshed,
          showCount: true,
          onClick: props.onFreshToggle,
        })}
        ${actionButtonTemplate({
          type: 'reply',
          count: formatCount(props.replyCount),
          showCount: true,
          onClick: props.onReplyToggle,
        })}
        ${reloadActionsDropdown}
      </div>
      <div class="post-actions-right">
        ${actionButtonTemplate({
          type: 'bookmark',
          isActive: props.isBookmarked,
          onClick: props.onBookmarkToggle,
        })}
        ${actionButtonTemplate({
          type: 'impressions',
          count: formatCount(props.impressions),
          showCount: true,
        })}
      </div>
      ${reactionsRow}
    `,
  );

  // One-shot feedback for the toggle that just turned ON.
  if (props.popAction) {
    const toggled = container.querySelector<HTMLElement>(`.action-button--${props.popAction}`);
    if (toggled) playOneShotPop(toggled);
  }

  return container;
}

function createReloadActionsDropdown(props: PostActionsProps): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'post-action-dropdown';

  mount(wrapper, () =>
    actionButtonTemplate({
      type: 'reload',
      count: formatCount(props.reloadCount),
      isActive: props.isReloaded,
      showCount: true,
    }),
  );
  const trigger = wrapper.querySelector<HTMLButtonElement>('.action-button--reload');
  if (!trigger) throw new Error('[post-actions] reload trigger failed to render');
  const dropdownId = `post-action-dropdown-${++nextActionDropdownId}`;
  trigger.setAttribute('aria-label', t('post_actions.more_actions'));
  trigger.setAttribute('title', t('post_actions.more_actions'));
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', dropdownId);
  let dropdown: HTMLDivElement | null = null;

  const closeDropdown = () => {
    if (!dropdown) return;
    dropdown.remove();
    dropdown = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('resize', positionDropdown);
    window.removeEventListener('scroll', positionDropdown, true);
  };

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!wrapper.contains(target) && !dropdown?.contains(target)) closeDropdown();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && dropdown) {
      event.stopPropagation();
      closeDropdown();
      trigger.focus();
    }
  };

  const positionDropdown = () => {
    if (!dropdown) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = dropdown.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
    const left = Math.min(Math.max(margin, triggerRect.left), maxLeft);
    const openAbove = triggerRect.top >= menuRect.height + margin * 2;
    const desiredTop = openAbove ? triggerRect.top - menuRect.height - 2 : triggerRect.bottom + 2;
    const top = Math.min(Math.max(margin, desiredTop), maxTop);

    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
  };

  const openDropdown = () => {
    dropdown = document.createElement('div');
    dropdown.id = dropdownId;
    dropdown.className = 'post-action-dropdown-menu';
    dropdown.setAttribute('role', 'group');
    dropdown.setAttribute('aria-label', t('post_actions.more_actions'));

    const actions: Array<{ label: string; iconName: IconName; onClick: () => void }> = [
      { label: t('post_actions.reload'), iconName: 'reload', onClick: props.onReloadToggle },
      { label: t('post_actions.quote'), iconName: 'quote', onClick: () => props.onQuote?.() },
      { label: t('post_actions.share'), iconName: 'share', onClick: () => props.onShare?.() },
    ];

    for (const action of actions) {
      const item = createMenuItem({
        label: action.label,
        onClick: () => {
          closeDropdown();
          action.onClick();
        },
      });
      item.type = 'button';
      item.className = 'post-action-dropdown-item';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.gap = '0.5rem';

      const iconEl = document.createElement('span');
      iconEl.className = 'post-action-dropdown-icon';
      iconEl.appendChild(icon(action.iconName));

      const labelEl = document.createElement('span');
      labelEl.className = 'post-action-dropdown-label';
      labelEl.textContent = action.label;
      item.replaceChildren(iconEl, labelEl);
      dropdown.appendChild(item);
    }

    document.body.appendChild(dropdown);
    positionDropdown();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', positionDropdown);
    window.addEventListener('scroll', positionDropdown, true);
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (dropdown) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  return wrapper;
}

function createReactionsRow(
  reactions: ReactionSummary[],
  onToggle: (emoji: string) => void,
  popReaction?: string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'post-reactions';

  // The chips are keyed by emoji. The row is rebuilt by PostCard only when its
  // signature changes, so this mostly makes the initial render declarative and
  // keeps the picker button outside the keyed range.
  mount(
    row,
    () =>
      html`
      ${each(
        () => reactions,
        (reaction) => reaction.emoji,
        (reaction) => legacy(createReactionChip(reaction(), onToggle, popReaction)),
      )}
      <button
        class="post-reaction-add"
        aria-label=${t('post.reactions_add')}
        title=${t('post.reactions_add')}
      >
        <span class="post-reaction-add-icon">${icon('smile-plus')}</span>
      </button>
    `,
  );

  // Add-reaction button that opens the emoji picker
  const addButton = row.querySelector<HTMLButtonElement>('.post-reaction-add');
  addButton?.addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker(addButton, onToggle);
  });

  return row;
}

function createReactionChip(
  reaction: ReactionSummary,
  onToggle: (emoji: string) => void,
  popReaction?: string,
): HTMLElement {
  const chip = document.createElement('button');
  chip.className = `post-reaction-chip${reaction.reacted ? ' reacted' : ''}`;
  chip.dataset.emoji = reaction.emoji;
  chip.setAttribute('aria-pressed', String(reaction.reacted));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle(reaction.emoji);
  });
  if (popReaction && reaction.emoji === popReaction) {
    playOneShotPop(chip);
  }

  const emojiSpan = document.createElement('span');
  emojiSpan.className = 'post-reaction-emoji';
  if (reaction.stamp_url) {
    const img = document.createElement('img');
    img.src = reaction.stamp_url;
    img.alt = reaction.emoji;
    img.style.cssText = 'width: 1.2em; height: 1.2em; vertical-align: -0.2em;';
    emojiSpan.appendChild(img);
  } else {
    emojiSpan.textContent = reaction.emoji;
  }

  const countSpan = document.createElement('span');
  countSpan.className = 'post-reaction-count';
  countSpan.textContent = String(reaction.count);

  chip.appendChild(emojiSpan);
  chip.appendChild(countSpan);

  return chip;
}

function openEmojiPicker(anchor: HTMLElement, onPick: (emoji: string) => void): void {
  openStampPicker(anchor, { onSelect: onPick });
}

interface ActionButtonOptions {
  type: ActionButtonType;
  count?: string;
  isActive?: boolean;
  showCount?: boolean;
  onClick?: () => void;
}

function actionButtonTemplate(options: ActionButtonOptions) {
  const { type, count = '', isActive = false, showCount = false, onClick } = options;
  const label = type === 'reload' ? t('post_actions.reload') : t('post_actions.aria_label', { type });
  const className = `action-button action-button--${type}${isActive ? ' action-button--active' : ''}`;
  // Toggle semantics for the two single-state actions. Reload opens a
  // disclosure menu, so aria-pressed would be the wrong role there.
  const pressed = type === 'fresh' || type === 'bookmark' ? String(isActive) : null;

  return html`
    <button class=${className} aria-label=${label} title=${label} aria-pressed=${pressed} @click=${onClick ?? (() => {})}>
      <span class="action-icon">${icon(getIconNameForType(type))}</span>
      ${showCount ? html`<span class="action-count">${count}</span>` : ''}
    </button>
  `;
}

type ActionButtonType = 'fresh' | 'bookmark' | 'reply' | 'reload' | 'share' | 'impressions' | 'quote';

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
