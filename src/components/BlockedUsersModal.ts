import { attachPlusBadge } from '../lib/avatar.js';
import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

interface BlockedUsersModalOptions {
  onUnblock?: (username: string) => void;
}

/**
 * Builds a modal that lists the users the current account has blocked and lets
 * the user unblock them. Returns the overlay element; the caller is responsible
 * for appending it to the document body.
 */
export function createBlockedUsersModal(options: BlockedUsersModalOptions = {}): HTMLElement {
  const unregister = registerModal();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    width: 90%;
    max-width: 480px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  `;

  const title = document.createElement('h2');
  title.textContent = t('settings.blocked_users');
  title.style.cssText = 'margin: 0; font-size: 1.125rem; font-weight: 600; color: var(--text-primary);';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', t('common.close') || 'Close');
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  `;

  const destroy = () => {
    unregister();
    if (overlay.parentNode) overlay.remove();
  };
  closeBtn.addEventListener('click', destroy);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) destroy();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'padding: 1rem 1.25rem; overflow-y: auto;';

  const message = document.createElement('div');
  message.style.cssText = 'font-size: 0.875rem; min-height: 1.25rem; margin-bottom: 0.5rem;';
  body.appendChild(message);

  const list = document.createElement('div');
  list.style.cssText = 'display: flex; flex-direction: column; gap: 0.75rem;';
  body.appendChild(list);

  dialog.appendChild(body);
  overlay.appendChild(dialog);

  const renderRow = (u: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  }) => {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem;
      border: 1px solid var(--border);
      border-radius: 6px;
    `;

    const avatarUrl = u.avatar_key ? `/api/images/${u.avatar_key}` : '/api/images/default-avatar';
    const avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'position: relative; width: 40px; height: 40px; flex-shrink: 0;';
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = '';
    img.style.cssText = 'width: 40px; height: 40px; border-radius: 50%; object-fit: cover; display: block;';
    img.onerror = () => {
      img.src = '/api/images/default-avatar';
    };
    avatarWrap.appendChild(img);
    attachPlusBadge(avatarWrap, u.badge_type);
    row.appendChild(avatarWrap);

    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';
    const name = document.createElement('div');
    name.style.cssText =
      'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    name.textContent = u.display_name || u.username;
    const uname = document.createElement('div');
    uname.style.cssText =
      'color: var(--text-muted); font-size: 0.8125rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    uname.textContent = `@${u.username}`;
    info.appendChild(name);
    info.appendChild(uname);
    row.appendChild(info);

    const unblockBtn = document.createElement('button');
    unblockBtn.textContent = t('settings.blocked_unblock');
    unblockBtn.style.cssText = `
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: none;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.8125rem;
      white-space: nowrap;
      transition: background 0.2s;
    `;
    unblockBtn.addEventListener('mouseenter', () => {
      unblockBtn.style.background = 'var(--bg-secondary)';
    });
    unblockBtn.addEventListener('mouseleave', () => {
      unblockBtn.style.background = 'none';
    });
    unblockBtn.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(
        t('settings.blocked_unblock_confirm', { username: `@${u.username}` }),
      );
      if (!confirmed) return;
      unblockBtn.disabled = true;
      unblockBtn.style.opacity = '0.5';
      try {
        const unr = await fetch(`/api/users/${u.username}/block`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (unr.ok) {
          row.style.transition = 'opacity 0.3s, transform 0.3s';
          row.style.opacity = '0';
          row.style.transform = 'translateX(-100%)';
          setTimeout(() => row.remove(), 300);
          message.textContent = t('settings.blocked_unblocked');
          message.style.color = 'var(--success, #10b981)';
          options.onUnblock?.(u.username);
          if (list.childElementCount === 0) {
            list.textContent = t('settings.blocked_empty');
            list.style.color = 'var(--text-muted)';
            list.style.fontSize = '0.875rem';
          }
        } else {
          throw new Error('Failed to unblock');
        }
      } catch {
        message.textContent = t('settings.blocked_unblock_failed');
        message.style.color = 'var(--danger)';
        unblockBtn.disabled = false;
        unblockBtn.style.opacity = '1';
      }
    });
    row.appendChild(unblockBtn);

    list.appendChild(row);
  };

  (async () => {
    try {
      const res = await fetch('/api/users/me/blocked', { credentials: 'include' });
      if (!res.ok) {
        message.textContent = t('settings.blocked_load_failed');
        message.style.color = 'var(--danger)';
        return;
      }
      const data = (await res.json()) as {
        users: Array<{
          id: string;
          username: string;
          display_name?: string;
          avatar_key?: string;
          badge_type?: string | null;
        }>;
      };
      if (data.users.length === 0) {
        list.textContent = t('settings.blocked_empty');
        list.style.color = 'var(--text-muted)';
        list.style.fontSize = '0.875rem';
        return;
      }
      for (const u of data.users) renderRow(u);
    } catch {
      message.textContent = t('settings.blocked_load_failed');
      message.style.color = 'var(--danger)';
    }
  })();

  return overlay;
}
