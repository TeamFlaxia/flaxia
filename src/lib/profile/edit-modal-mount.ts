import { mount, unmount } from 'svelte';
import EditProfileModal from '../svelte/EditProfileModal.svelte';
import type { ProfileModalUser } from './modals.ts';

export function mountEditProfileModal(user: ProfileModalUser, onSave: () => void): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let instance: ReturnType<typeof mount> | null = null;
  const close = () => {
    if (instance) void unmount(instance);
    instance = null;
    host.remove();
  };
  instance = mount(EditProfileModal, { target: host, props: { currentUser: user, onSave, onClose: close } });
}
