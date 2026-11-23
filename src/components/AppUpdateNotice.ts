// Legacy-compatible bridge: the notice UI is owned by AppUpdateNotice.svelte;
// this keeps the single-instance guard and mount lifecycle.
import { type Component, mount, unmount } from 'svelte';
import type { AppUpdateInfo } from '../lib/app-update.js';
import AppUpdateNotice from '../lib/svelte/AppUpdateNotice.svelte';

const NOTICE_ID = 'app-update-notice';

/** Show the update card once; a second call is ignored until it is dismissed. */
export function showAppUpdateNotice(update: AppUpdateInfo, onDismiss: () => void): void {
  if (document.getElementById(NOTICE_ID)) return;

  let instance: Parameters<typeof unmount>[0] | null = null;
  const dismiss = (): void => {
    onDismiss();
    if (instance) void unmount(instance);
    instance = null;
  };

  instance = mount(AppUpdateNotice as Component, {
    target: document.body,
    props: { update, onDismiss: dismiss },
  });
}
