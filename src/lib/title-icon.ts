/**
 * Title icons are same-origin or absolute image URLs. Keeping this check in one
 * place prevents the UI and SSR renderer from treating an icon path as literal
 * text and gives non-image legacy rows a safe name-only fallback.
 */
export function isTitleIconImage(icon?: string | null): icon is string {
  if (!icon) return false;
  return (icon.startsWith('/') && !icon.startsWith('//')) || /^https?:\/\//i.test(icon);
}
