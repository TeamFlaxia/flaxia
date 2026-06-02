export type ReplyStyle = 'twitter' | '2ch';

const STORAGE_KEY = 'flaxia_reply_style';

export function getReplyStyle(): ReplyStyle {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'twitter' || stored === '2ch') return stored;
  } catch {}
  return '2ch';
}

export function setReplyStyle(style: ReplyStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {}
}
