// Arcade display title: the game's HTML <title> wins, the post body is the
// fallback. Kept shared so the API feed and the SSR pages agree exactly.
import { stripPostColors } from './post-colors.ts';

export function cleanGameTitle(raw: string | null | undefined, maxLen = 100): string {
  return (raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function arcadeGameTitle(
  htmlTitle: string | null | undefined,
  text: string | null | undefined,
  username?: string | null,
): string {
  return (
    cleanGameTitle(htmlTitle) ||
    stripPostColors(text ?? '').substring(0, 100) ||
    (username ? `Game by @${username}` : 'Untitled Game')
  );
}
