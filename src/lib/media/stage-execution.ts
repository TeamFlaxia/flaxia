// Executor bridge for the Svelte PostStage: keeps the imperative ZIP/SWF/HTML
// runtimes behind one handle so the component never calls a legacy factory.
import type { Post } from '../../../shared/types/post.ts';
import { executeFlash } from '../../components/FlashPlayer.js';
import { executeZipAuto } from '../zip-manager.js';
import { isZipGame } from './stage.ts';

export interface StageExecutionHandle {
  destroy: () => void;
}

export async function runStageExecution(
  post: Post,
  host: HTMLElement,
  sandboxOrigin: string,
  versionId?: string | null,
): Promise<StageExecutionHandle> {
  if (isZipGame(post.payload_key)) {
    const handle = await executeZipAuto(post.id, host, undefined, versionId ?? undefined);
    return { destroy: () => handle.destroy() };
  }

  if (post.swf_key?.startsWith('swf/')) {
    const handle = await executeFlash(post.id, host);
    return { destroy: () => handle.destroy() };
  }

  const { createSandboxFrame } = await import('../../components/SandboxFrame.js');
  const frame = createSandboxFrame({
    postId: post.id,
    sandboxOrigin,
    versionId: versionId ?? undefined,
  });
  host.appendChild(frame);
  return { destroy: () => frame.remove() };
}
