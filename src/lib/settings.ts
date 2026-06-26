export type ReplyStyle = 'twitter' | '2ch';

const REPLY_STYLE_KEY = 'flaxia_reply_style';
const NSFW_KEY = 'flaxia_show_nsfw';

export function getReplyStyle(): ReplyStyle {
  try {
    const stored = localStorage.getItem(REPLY_STYLE_KEY);
    if (stored === 'twitter' || stored === '2ch') return stored;
  } catch {}
  return '2ch';
}

export function setReplyStyle(style: ReplyStyle): void {
  try {
    localStorage.setItem(REPLY_STYLE_KEY, style);
  } catch {}
}

export function getShowNsfw(): boolean {
  try {
    return localStorage.getItem(NSFW_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setShowNsfw(show: boolean): void {
  try {
    localStorage.setItem(NSFW_KEY, String(show));
  } catch {}
}
