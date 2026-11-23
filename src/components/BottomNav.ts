// Legacy-compatible bridge: the bottom navigation UI is owned by
// BottomNav.svelte; this keeps the class API used by the shell bootstrap.
import { type Component, mount, unmount } from 'svelte';
import BottomNavView from '../lib/svelte/BottomNav.svelte';

export interface BottomNavProps {
  activeItem?: string;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
  onSignUp?: () => void;
}

interface Instance {
  setActiveItem: (item: string) => void;
  updateUser: (user: BottomNavProps['currentUser']) => void;
  getActiveItem: () => string;
}

/** Mobile-only bottom navigation bar, rendered as a single global instance. */
export class BottomNav {
  private element: HTMLElement;
  private instance: Instance & Parameters<typeof unmount>[0];

  constructor(props: BottomNavProps = {}) {
    this.element = document.createElement('div');
    this.instance = mount(BottomNavView as Component, {
      target: this.element,
      props: {
        activeItem: props.activeItem || 'home',
        currentUser: props.currentUser ?? null,
        onNavigate: props.onNavigate,
        onSignIn: props.onSignIn,
      },
    }) as unknown as Instance & Parameters<typeof unmount>[0];
  }

  public setActiveItem(item: string): void {
    this.instance.setActiveItem(item);
  }

  public updateUser(user: BottomNavProps['currentUser']): void {
    this.instance.updateUser(user ?? null);
  }

  public getActiveItem(): string {
    return this.instance.getActiveItem();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    void unmount(this.instance);
    this.element.remove();
  }
}

export function createBottomNav(props: BottomNavProps = {}): BottomNav {
  return new BottomNav(props);
}
