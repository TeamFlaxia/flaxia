import { t } from '../lib/i18n.js';
import { createMenuItem } from '../lib/modal-overlay.js';
import { each, html, legacy, mount } from '../lib/render/index.ts';
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

interface PostMenuEntry {
  key: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function createPostMenuDropdown(props: PostMenuProps): HTMLElement {
  const { isOwnPost, isRemote, showPinOption, pinned, payloadKey, currentUser, actions } = props;

  const dropdown = document.createElement('div');
  dropdown.className = 'post-menu-dropdown';

  const closeDropdown = () => {
    dropdown.remove();
  };

  // Build the entry list first, then render it through the engine: the menu is
  // one keyed list instead of eight hand-appended buttons.
  const entries: PostMenuEntry[] = [];

  if (!isRemote) {
    entries.push({
      key: 'version-history',
      label: t('game.version_history'),
      onClick: () => {
        closeDropdown();
        actions.onVersionHistory();
      },
    });
  }

  if (isOwnPost) {
    if (showPinOption) {
      entries.push({
        key: 'pin',
        label: pinned ? t('post.menu_unpin') : t('post.menu_pin'),
        onClick: () => {
          closeDropdown();
          actions.onTogglePin?.();
        },
      });
      entries.push({
        key: 'counter-notice',
        label: t('post.menu_counter_notice'),
        onClick: () => {
          closeDropdown();
          actions.onCounterNotice();
        },
      });
    }

    entries.push({
      key: 'edit',
      label: t('post.menu_edit'),
      onClick: () => {
        closeDropdown();
        actions.onEdit();
      },
    });

    if (isZipGame(payloadKey)) {
      entries.push({
        key: 'update',
        label: t('game.update'),
        onClick: () => {
          closeDropdown();
          actions.onUpdate();
        },
      });
    }

    entries.push({
      key: 'delete',
      label: t('post.menu_delete'),
      danger: true,
      onClick: () => {
        closeDropdown();
        actions.onDelete();
      },
    });
  } else {
    // Blocking a remote actor is a separate ActivityPub operation; do not
    // present the local block action for a post of another instance.
    if (!isRemote) {
      entries.push({
        key: 'block',
        label: t('post.menu_block'),
        danger: true,
        onClick: () => {
          closeDropdown();
          if (!requireAuth('block', actions.onBlock, currentUser)) return;
          actions.onBlock();
        },
      });
    }

    entries.push({
      key: 'report',
      label: t('post.menu_report'),
      onClick: () => {
        closeDropdown();
        if (!requireAuth('report', actions.onReport, currentUser)) return;
        actions.onReport();
      },
    });
  }

  mount(dropdown, () =>
    each(
      () => entries,
      (entry) => entry.key,
      (entry) =>
        legacy(
          createMenuItem({
            label: entry().label,
            danger: entry().danger,
            onClick: entry().onClick,
          }),
        ),
    ),
  );

  return dropdown;
}

export function createMenuButton(onClick: () => void): HTMLElement {
  const holder = document.createElement('div');
  let menuButton!: HTMLButtonElement;

  mount(
    holder,
    () =>
      html`<button type="button" class="post-menu-button" aria-label=${t('post_actions.more_actions')} @click=${(
        event: Event,
      ) => {
        event.stopPropagation();
        onClick();
      }} ref=${(element: Element | null) => {
        if (element) menuButton = element as unknown as HTMLButtonElement;
      }}>⋯</button>`,
  );

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
