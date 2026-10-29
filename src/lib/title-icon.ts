/**
 * Title icons are text glyphs (for example an emoji) or a same-origin/absolute
 * image URL. Keeping this check in one place prevents the UI and SSR renderer
 * from treating an icon path as literal text.
 */
export function isTitleIconImage(icon?: string | null): icon is string {
  if (!icon) return false;
  return (icon.startsWith('/') && !icon.startsWith('//')) || /^https?:\/\//i.test(icon);
}
