// Adapter around the legacy arcade engine (games, swipe, comments, capture).
// Keeps the 3,000-line DOM engine behind a .ts boundary while the Svelte route
// owns the shell and lifecycle.
import { createArcadePage } from '../../components/ArcadePage.ts';

export interface ArcadePageOptions {
  sandboxOrigin: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  initialGameId?: string;
  onBack?: () => void;
}

export interface ArcadePageHandle {
  element: HTMLElement;
  destroy: () => void;
  suspend: () => void;
  resume: () => void;
}

export function mountArcadePage(host: HTMLElement, options: ArcadePageOptions): ArcadePageHandle {
  const page = createArcadePage(options);
  host.replaceChildren(page.getElement());
  return {
    element: host,
    destroy: page.destroy,
    suspend: page.suspend,
    resume: page.resume,
  };
}
