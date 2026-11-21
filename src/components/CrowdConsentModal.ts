// Legacy-compatible bridge: the consent dialog is owned by
// CrowdConsentModal.svelte; this keeps the original factory API used by the
// bootstrap when the Crowd node asks for a consent decision.
import { type Component, mount, unmount } from 'svelte';
import CrowdConsentModalView from '../lib/svelte/CrowdConsentModal.svelte';

export interface CrowdConsentModalOptions {
  onAccept: () => void;
  onReject: () => void;
}

export function showCrowdConsentModal(options: CrowdConsentModalOptions): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(CrowdConsentModalView as Component, {
    target,
    props: {
      ...options,
      onDismiss: () => {
        unmount(instance as never);
        target.remove();
      },
    },
  });
}
