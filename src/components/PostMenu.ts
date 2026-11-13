import { t } from '../lib/i18n.js';
import { createMenuItem } from '../lib/modal-overlay.js';
import { isZipGame } from './PostStage.js';
import { type SignInPromptAction, showSignInPrompt } from './SignInPrompt.js';

export interface PostMenuActions {
  onVersionHistory: () => void;
  onTogglePin?: () => void;
  onCounterNotice: () => void;
  onEdit: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onBlock: () => void;
  onReport: () => void;
}

export interface PostMenuProps {
  isOwnPost: boolean;
  /** Remote posts have no local versions, blocks or reports target. */
  isRemote?: boolean;
  showPinOption?: boolean;
  pinned?: boolean;
  payloadKey?: string | null;
  currentUser?: { username: string; id: string } | null;
  actions: PostMenuActions;
}

function requireAuth(
  action: SignInPromptAction,
  callback: () => void,
  currentUser?: { username: string; id: string } | null,
): boolean {
  if (!currentUser) {
    showSignInPrompt(
      action,
      () => {
        window.history.pushState({}, '', '/login');
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      () => {
        window.history.pushState({}, '', '/register');
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    );
    return false;
  }
  return true;
}

export function createPostMenuDropdown(props: PostMenuProps): HTMLElement {
  const { isOwnPost, isRemote, showPinOption, pinned, payloadKey, currentUser, actions } = props;

  const dropdown = document.createElement('div');
  dropdown.className = 'post-menu-dropdown';

  const closeDropdown = () => {
    dropdown.remove();
  };

  // Version history only exists for local posts.
  if (!isRemote) {
    dropdown.appendChild(
      createMenuItem({
        label: t('game.version_history'),
        onClick: () => {
          closeDropdown();
          actions.onVersionHistory();
        },
      }),
    );
  }

  if (isOwnPost) {
    // Pin/unpin
    if (showPinOption) {
      dropdown.appendChild(
        createMenuItem({
          label: pinned ? t('post.menu_unpin') : t('post.menu_pin'),
          onClick: () => {
            closeDropdown();
            actions.onTogglePin?.();
          },
        }),
      );
    }

    // Counter notice (only for hidden posts)
    if (props.showPinOption) {
      dropdown.appendChild(
        createMenuItem({
          label: t('post.menu_counter_notice'),
          onClick: () => {
            closeDropdown();
            actions.onCounterNotice();
          },
        }),
      );
    }

    // Edit
    dropdown.appendChild(
      createMenuItem({
        label: t('post.menu_edit'),
        onClick: () => {
          closeDropdown();
          actions.onEdit();
        },
      }),
    );

    // Update (only for ZIP games)
    if (isZipGame(payloadKey)) {
      dropdown.appendChild(
        createMenuItem({
          label: t('game.update'),
          onClick: () => {
            closeDropdown();
            actions.onUpdate();
          },
        }),
      );
    }

    // Delete (danger)
    dropdown.appendChild(
      createMenuItem({
        label: t('post.menu_delete'),
        danger: true,
        onClick: () => {
          closeDropdown();
          actions.onDelete();
        },
      }),
    );
  } else {
    // Blocking a remote actor is a separate ActivityPub operation; do not
    // present the local block action for a post of another instance.
    if (!isRemote) {
      dropdown.appendChild(
        createMenuItem({
          label: t('post.menu_block'),
          danger: true,
          onClick: () => {
            closeDropdown();
            if (!requireAuth('block', actions.onBlock, currentUser)) return;
            actions.onBlock();
          },
        }),
      );
    }

    // Report
    dropdown.appendChild(
      createMenuItem({
        label: t('post.menu_report'),
        onClick: () => {
          closeDropdown();
          if (!requireAuth('report', actions.onReport, currentUser)) return;
          actions.onReport();
        },
      }),
    );
  }

  return dropdown;
}

export function createMenuButton(onClick: () => void): HTMLElement {
  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'post-menu-button';
  menuButton.textContent = '⋯';
  menuButton.setAttribute('aria-label', t('post_actions.more_actions'));

  menuButton.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });

  return menuButton;
}

export function setupMenuCloseHandler(dropdown: HTMLElement, onClose: () => void): void {
  const closeMenu = (e: MouseEvent) => {
    if (!dropdown.contains(e.target as Node)) {
      onClose();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}
