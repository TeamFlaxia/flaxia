// Adapters around legacy modal factories used by the Svelte profile page.

import { mount, unmount } from 'svelte';
import { createBlockedUsersModal } from '../../components/BlockedUsersModal.ts';
import { clearMeCache } from '../auth-cache.ts';
import { createConfirmDialog } from '../confirm-dialog.ts';
import { safeRemoveFromBody } from '../dom-utils.ts';
import { t } from '../i18n.ts';
import { registerModal } from '../modal-state.ts';
import { navigate } from '../navigation.ts';
import FollowerListModal from '../svelte/FollowerListModal.svelte';
import { mountEditProfileModal } from './edit-modal-mount.ts';

export interface ProfileModalUser {
  username: string;
  display_name?: string;
  bio?: string;
  avatar_key?: string | null;
  badge_type?: string | null;
  name_color?: string | null;
  equipped_title_id?: string | null;
  header_key?: string | null;
}

export function openEditProfile(user: ProfileModalUser, onSave: () => void): void {
  mountEditProfileModal(user, onSave);
}

export function openFollowerList(
  username: string,
  initialTab: 'followers' | 'following',
  currentUser: ProfileModalUser | null,
): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let instance: ReturnType<typeof mount> | null = null;
  const close = () => {
    if (instance) void unmount(instance);
    instance = null;
    host.remove();
  };
  instance = mount(FollowerListModal, { target: host, props: { username, initialTab, currentUser, onClose: close } });
}

export function openBlockedUsers(onUnblock: () => void): void {
  document.body.appendChild(createBlockedUsersModal({ onUnblock }));
}

export async function confirmBlock(username: string): Promise<boolean> {
  return createConfirmDialog(t('profile.block_confirm', { username: `@${username}` }));
}

export function showLogoutConfirm(username: string): void {
  const overlay = document.createElement('div');
  const unregister = registerModal();
  overlay.setAttribute(
    'style',
    'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;',
  );
  const modal = document.createElement('div');
  modal.setAttribute(
    'style',
    'background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:320px;width:90%;text-align:center;',
  );
  modal.innerHTML = `
    <h3 style="margin:0 0 1rem 0;color:var(--text-primary);font-size:1.125rem;">${t('profile.logout_title', { username })}</h3>
    <div style="display:flex;gap:0.75rem;justify-content:center;">
      <button class="logout-cancel-btn" style="padding:0.5rem 1rem;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:9999px;cursor:pointer;font-size:0.875rem;">${t('common.cancel')}</button>
      <button class="logout-confirm-btn" style="padding:0.5rem 1rem;background:var(--text-primary);color:var(--bg-primary);border:none;border-radius:9999px;cursor:pointer;font-size:0.875rem;font-weight:600;">${t('auth.sign_out')}</button>
    </div>`;
  const close = () => {
    unregister();
    overlay.remove();
  };
  modal.querySelector('.logout-cancel-btn')?.addEventListener('click', close);
  modal.querySelector('.logout-confirm-btn')?.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (response.ok) {
        clearMeCache();
        await navigate('/', { replaceState: true });
        window.location.reload();
      } else close();
    } catch {
      close();
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
