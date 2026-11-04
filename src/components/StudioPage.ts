// Thin wrapper: the Studio project lives in @flaxia/studio.
import { createStudioPage as createStudio } from '@flaxia/studio';
import { configureStudioHost } from '@flaxia/studio/host';
import { createStudioHost } from '../lib/studio-host.js';

export function createStudioPage(): { getElement(): HTMLElement; destroy(): void } {
  configureStudioHost(createStudioHost());
  return createStudio();
}
