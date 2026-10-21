import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { type PostActionsProps, type ReactionSummary } from '../types/post.js';
import { openStampPicker } from './StampPicker.js';

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

  // Quote button (no count)
  const quoteButton = createActionButton('quote', '', false, false);
  quoteButton.addEventListener('click', () => {
    if (props.onQuote) props.onQuote();
  });

  // Bookmark button (no count)
  const bookmarkButton = createActionButton('bookmark', '', props.isBookmarked, false);
  bookmarkButton.addEventListener('click', props.onBookmarkToggle);

  // Share button (no count)
  const shareButton = createActionButton('share', '', false, false);
  shareButton.addEventListener('click', () => {
    if (props.onShare) {
      props.onShare();
    }
  });

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
  leftGroup.appendChild(quoteButton);

  // Right-aligned group: rightmost impressions, then share, then bookmark
  rightGroup.appendChild(bookmarkButton);
  rightGroup.appendChild(shareButton);
  rightGroup.appendChild(impressionsButton);

  container.appendChild(leftGroup);
  container.appendChild(rightGroup);

  container.appendChild(createReactionsRow(props.reactions, props.onReactionToggle));

  return container;
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
  button.setAttribute('aria-label', t('post_actions.aria_label', { type }));

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

type ActionButtonType = 'fresh' | 'bookmark' | 'reply' | 'share' | 'impressions' | 'quote';

function getIconNameForType(type: ActionButtonType): IconName {
  switch (type) {
    case 'fresh':
      return 'fresh';
    case 'bookmark':
      return 'bookmark';
    case 'reply':
      return 'reply';
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
