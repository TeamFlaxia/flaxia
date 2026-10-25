import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { createMenuItem } from '../lib/modal-overlay.js';
import { type PostActionsProps, type ReactionSummary } from '../types/post.js';
import { openStampPicker } from './StampPicker.js';

let nextActionDropdownId = 0;

export function createPostActions(props: PostActionsProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'post-actions';

  const leftGroup = document.createElement('div');
  leftGroup.className = 'post-actions-left';

  const rightGroup = document.createElement('div');
  rightGroup.className = 'post-actions-right';

  // Fresh! button
  const freshButton = createActionButton('fresh', formatCount(props.freshCount), props.isFreshed, true);
  freshButton.addEventListener('click', props.onFreshToggle);

  // Reply button
  const replyButton = createActionButton('reply', formatCount(props.replyCount), false, true);
  replyButton.addEventListener('click', props.onReplyToggle);

  const reloadActionsDropdown = createReloadActionsDropdown(props);

  // Bookmark button (no count)
  const bookmarkButton = createActionButton('bookmark', '', props.isBookmarked, false);
  bookmarkButton.addEventListener('click', props.onBookmarkToggle);

  // Impressions button (display only, not clickable)
  const impressionsButton = createActionButton('impressions', formatCount(props.impressions), false, true);
  impressionsButton.style.cursor = 'default';
  const impressionsIcon = impressionsButton.querySelector('.action-icon') as HTMLElement;
  if (impressionsIcon) {
    impressionsIcon.style.fontSize = '0.75rem';
    impressionsIcon.style.opacity = '0.5';
  }

  leftGroup.appendChild(freshButton);
  leftGroup.appendChild(replyButton);
  leftGroup.appendChild(reloadActionsDropdown);

  // Right-aligned group: rightmost impressions, then bookmark
  rightGroup.appendChild(bookmarkButton);
  rightGroup.appendChild(impressionsButton);

  container.appendChild(leftGroup);
  container.appendChild(rightGroup);

  container.appendChild(createReactionsRow(props.reactions, props.onReactionToggle));

  return container;
}

function createReloadActionsDropdown(props: PostActionsProps): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'post-action-dropdown';

  const trigger = createActionButton('reload', formatCount(props.reloadCount), props.isReloaded, true);
  const dropdownId = `post-action-dropdown-${++nextActionDropdownId}`;
  trigger.setAttribute('aria-label', t('post_actions.more_actions'));
  trigger.setAttribute('title', t('post_actions.more_actions'));
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', dropdownId);
  wrapper.appendChild(trigger);

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

function createReactionsRow(reactions: ReactionSummary[], onToggle: (emoji: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'post-reactions';

  for (const reaction of reactions) {
    row.appendChild(createReactionChip(reaction, onToggle));
  }

  // Add-reaction button that opens the emoji picker
  const addButton = document.createElement('button');
  addButton.className = 'post-reaction-add';
  addButton.setAttribute('aria-label', t('post.reactions_add'));
  addButton.setAttribute('title', t('post.reactions_add'));
  const iconEl = document.createElement('span');
  iconEl.className = 'post-reaction-add-icon';
  iconEl.appendChild(icon('smile-plus'));
  addButton.appendChild(iconEl);

  addButton.addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker(addButton, onToggle);
  });

  row.appendChild(addButton);

  return row;
}

function createReactionChip(reaction: ReactionSummary, onToggle: (emoji: string) => void): HTMLElement {
  const chip = document.createElement('button');
  chip.className = `post-reaction-chip${reaction.reacted ? ' reacted' : ''}`;
  chip.setAttribute('aria-pressed', String(reaction.reacted));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle(reaction.emoji);
  });

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

function createActionButton(type: ActionButtonType, count: string, isActive: boolean, showCount: boolean): HTMLElement {
  const button = document.createElement('button');
  button.className = `action-button action-button--${type}`;
  const label = type === 'reload' ? t('post_actions.reload') : t('post_actions.aria_label', { type });
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);

  if (isActive) {
    button.classList.add('action-button--active');
  }

  // Create icon (universal Lucide icon, not OS-dependent emoji)
  const iconEl = document.createElement('span');
  iconEl.className = 'action-icon';
  iconEl.appendChild(icon(getIconNameForType(type)));

  button.appendChild(iconEl);

  // Add count for fresh, reply and impressions buttons only
  if (showCount) {
    const countSpan = document.createElement('span');
    countSpan.className = 'action-count';
    countSpan.textContent = count;

    button.appendChild(countSpan);
  }

  return button;
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
