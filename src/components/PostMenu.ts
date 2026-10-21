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
  const { isOwnPost, showPinOption, pinned, payloadKey, currentUser, actions } = props;

  const dropdown = document.createElement('div');
  dropdown.className = 'post-menu-dropdown';
  dropdown.style.cssText = `
    position: absolute;
    top: 30px;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    z-index: 100;
    min-width: 120px;
  `;

  const closeDropdown = () => {
    dropdown.remove();
  };

  // Version history (always shown)
  dropdown.appendChild(
    createMenuItem({
      label: t('game.version_history'),
      onClick: () => {
        closeDropdown();
        actions.onVersionHistory();
      },
    }),
  );

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
    // Block (danger) - other user's post
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
  menuButton.className = 'post-menu-button';
  menuButton.textContent = '⋯';
  menuButton.style.cssText = `
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: color 0.2s ease;
  `;

  menuButton.addEventListener('mouseenter', () => {
    menuButton.style.color = 'var(--text-primary)';
  });
  menuButton.addEventListener('mouseleave', () => {
    menuButton.style.color = 'var(--text-muted)';
  });

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
