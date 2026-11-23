import { type Component, type ComponentProps, mount, unmount } from 'svelte';

export interface ModalMountHandle {
  host: HTMLElement;
  destroy: () => void;
}

export interface ModalMountOptions {
  /** Append the host to the body before mounting (matches factory dialogs). */
  appendToBody?: boolean;
}

/**
 * Mount a Svelte dialog into a host element and hand the component a `destroy`
 * callback. Adapters keep their legacy signatures while the DOM is Svelte-owned.
 */
export function mountSvelteModal<C extends Component<any, any>>(
  component: C,
  buildProps: (destroy: () => void) => ComponentProps<C>,
  options: ModalMountOptions = {},
): ModalMountHandle {
  const host = document.createElement('div');
  let instance: ReturnType<typeof mount> | null = null;

  const destroy = () => {
    if (instance) void unmount(instance);
    instance = null;
    host.remove();
  };

  if (options.appendToBody) document.body.appendChild(host);
  instance = mount(component, { target: host, props: buildProps(destroy) });

  return { host, destroy };
}
