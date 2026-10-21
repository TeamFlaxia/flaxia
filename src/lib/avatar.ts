import { t } from './i18n.js';

/** Badge types that render a checkmark on avatars today. */
const RENDERABLE_BADGES = new Set(['flaxia_plus']);

function checkSvg(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M20 6 9 17l-5-5');
  svg.appendChild(path);
  return svg;
}

/**
 * Attach a bottom-right badge to an avatar element when `badgeType` is a
 * currently rendered type (e.g. `flaxia_plus`). The host gets
 * `avatar-plus-host` so CSS can position it relatively.
 */
export function attachPlusBadge(el: HTMLElement, badgeType?: string | null): void {
  if (!badgeType || !RENDERABLE_BADGES.has(badgeType)) return;
  // Avoid double-appending on re-render.
  if (el.querySelector(':scope > .avatar-plus-badge')) return;

  const label = badgeType === 'flaxia_plus' ? t('badge.flaxia_plus') : badgeType;
  const badge = document.createElement('span');
  badge.className = 'avatar-plus-badge';
  badge.title = label;
  badge.setAttribute('aria-label', label);
  badge.appendChild(checkSvg());

  el.classList.add('avatar-plus-host');
  el.appendChild(badge);
}
