import { mount, unmount } from 'svelte';
import AddStampModal from '../svelte/AddStampModal.svelte';

/** Mount the Svelte stamp modal on the document body. */
export function openAddStampModal(onUploaded: () => void): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let instance: ReturnType<typeof mount> | null = null;
  const close = () => {
    if (instance) void unmount(instance);
    instance = null;
    host.remove();
  };
  instance = mount(AddStampModal, { target: host, props: { onUploaded, onClose: close } });
}
