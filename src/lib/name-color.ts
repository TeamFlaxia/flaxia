/**
 * Flaxia+ display-name colors.
 *
 * The palette is the only source of truth: the server rejects anything that is
 * not in this list, so a stored value is always safe to place in an inline
 * `color` style (no CSS injection surface).
 */
export const NAME_COLOR_PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
] as const;

export type NameColor = (typeof NAME_COLOR_PALETTE)[number];

const NAME_COLOR_SET: ReadonlySet<string> = new Set(NAME_COLOR_PALETTE);

/** Normalize a stored/requested color to a palette value, or null when invalid. */
export function normalizeNameColor(value: unknown): NameColor | null {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  return NAME_COLOR_SET.has(color) ? (color as NameColor) : null;
}

/**
 * Colors are a Flaxia+ entitlement. Even if a stale value is left in the
 * database after a subscription lapses, it must not render for non-members.
 */
export function resolveNameColor(
  nameColor: string | null | undefined,
  badgeType: string | null | undefined,
): NameColor | null {
  if (badgeType !== 'flaxia_plus') return null;
  return normalizeNameColor(nameColor);
}

// Elements often carry their own inline color (for example muted secondary
// text). Remember it so clearing a name color restores the original instead of
// deleting the element's only color declaration.
const BASE_COLOR_ATTR = 'data-name-color-base';

/** Apply the resolved color to a display-name element (or restore its base). */
export function applyNameColor(
  el: HTMLElement,
  nameColor: string | null | undefined,
  badgeType: string | null | undefined,
): void {
  const color = resolveNameColor(nameColor, badgeType);
  if (color) {
    if (!el.hasAttribute(BASE_COLOR_ATTR)) {
      el.setAttribute(BASE_COLOR_ATTR, el.style.color);
    }
    el.style.color = color;
    return;
  }

  if (el.hasAttribute(BASE_COLOR_ATTR)) {
    const baseColor = el.getAttribute(BASE_COLOR_ATTR);
    if (baseColor) {
      el.style.color = baseColor;
    } else {
      el.style.removeProperty('color');
    }
    el.removeAttribute(BASE_COLOR_ATTR);
  }
}
