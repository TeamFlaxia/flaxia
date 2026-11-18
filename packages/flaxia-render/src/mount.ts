import { createOwner, disposeOwner, getCurrentOwner, runInOwner } from './owner.ts';
import { ChildPart, type Renderable } from './template.ts';

export interface Mounted {
  readonly element: Element;
  dispose(): void;
}

/**
 * Mount a render tree into `container`.
 *
 * The root comment is the only anchor written directly; the first render goes
 * into a DocumentFragment and is inserted once. This is the property that keeps
 * navigation from flashing an empty content column.
 */
export function mount(container: Element, render: () => Renderable): Mounted {
  const owner = createOwner();
  const anchor = document.createComment('flx:root');
  container.replaceChildren(anchor);

  const part = runInOwner(owner, () => new ChildPart(anchor, owner));
  const value = runInOwner(owner, render);
  runInOwner(owner, () => part.set(value));

  let disposed = false;
  return {
    element: container,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      part.dispose();
      disposeOwner(owner);
      container.replaceChildren();
    },
  };
}

/**
 * Run `fn` once after the current render has been attached to the document.
 * Used for measurement, focus and entrance animations.
 */
export function onMount(fn: () => void): void {
  const owner = getCurrentOwner();
  queueMicrotask(() => {
    if (owner?.disposed) return;
    runInOwner(owner, fn);
  });
}
