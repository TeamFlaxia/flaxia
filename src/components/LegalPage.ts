// Legacy-compatible bridge kept for the render test. Production legal routes
// now render src/lib/svelte/LegalPage.svelte directly.
import { mount, unmount } from 'svelte';
import type { LegalPageType } from '../lib/legal/pages.ts';
import LegalPage from '../lib/svelte/LegalPage.svelte';

interface LegalPageProps {
  type: LegalPageType;
}

export function createLegalPage({ type }: LegalPageProps) {
  const target = document.createElement('div');
  target.className = 'legal-page';
  const instance = mount(LegalPage, { target, props: { type } });
  return {
    getElement: () => target,
    destroy: () => unmount(instance),
  };
}
