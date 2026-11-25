// Small adapter so Svelte components can render legacy SVG icons.
import { type IconName, iconMarkup } from '../icons.ts';

export function iconHtml(name: IconName, size = 16): string {
  return iconMarkup(name, { width: String(size), height: String(size) });
}
