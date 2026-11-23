// Legacy-compatible bridge: the stage UI is owned by PostStage.svelte. Callers
// keep using createPostStage / updatePostStage / destroyPostStage.
import { type Component, mount, unmount } from 'svelte';
import type { PostStageProps } from '../../shared/types/post.ts';
import { isZipGame, stripLeadingEmoji } from '../lib/media/stage.ts';
import PostStageView from '../lib/svelte/media/PostStage.svelte';

export { isZipGame, stripLeadingEmoji };

interface PostStageInstance {
  update: (next: { post: PostStageProps['post']; mode: PostStageProps['mode']; versionId?: string }) => void;
  destroy?: () => void;
}

const stages = new WeakMap<HTMLElement, { instance: PostStageInstance }>();

export function createPostStage(props: PostStageProps): HTMLElement {
  const container = document.createElement('div');
  const instance = mount(PostStageView as Component, {
    target: container,
    props: props as never,
  }) as unknown as PostStageInstance;
  stages.set(container, { instance });
  return container;
}

export function updatePostStage(container: HTMLElement, props: PostStageProps): void {
  stages.get(container)?.instance.update({
    post: props.post,
    mode: props.mode,
    versionId: props.versionId,
  });
}

/** Release a stage's timers, iframe handles and layers. */
export function destroyPostStage(container: HTMLElement): void {
  const stage = stages.get(container);
  if (!stage) return;
  stages.delete(container);
  stage.instance.destroy?.();
  unmount(stage.instance as never);
}
