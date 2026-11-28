export type ReplyStyle = 'twitter' | '2ch';

const REPLY_STYLE_KEY = 'flaxia_reply_style';
const NSFW_KEY = 'flaxia_show_nsfw';
const DATA_SAVER_KEY = 'flaxia_data_saver';
const FOR_YOU_EXTERNAL_KEY = 'flaxia_foryou_external';

export const DATA_SAVER_CHANGE_EVENT = 'flaxia:data-saver-change';
export const FOR_YOU_EXTERNAL_CHANGE_EVENT = 'flaxia:foryou-external-change';

export type ForYouExternalMode = 'show' | 'hide';

/** Whether federated posts may appear in For You. `show` is the default. */
export function getForYouExternalMode(): ForYouExternalMode {
  try {
    const stored = localStorage.getItem(FOR_YOU_EXTERNAL_KEY);
    if (stored === 'show' || stored === 'hide') return stored;
  } catch {}
  return 'show';
}

export function isForYouExternalHidden(): boolean {
  return getForYouExternalMode() === 'hide';
}

export function setForYouExternalMode(mode: ForYouExternalMode): void {
  try {
    localStorage.setItem(FOR_YOU_EXTERNAL_KEY, mode);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(FOR_YOU_EXTERNAL_CHANGE_EVENT, { detail: mode }));
  } catch {
    // Non-DOM test environments have no window.
  }
}

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

export function getDataSaverMode(): boolean {
  try {
    return localStorage.getItem(DATA_SAVER_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setDataSaverMode(enabled: boolean): void {
  try {
    localStorage.setItem(DATA_SAVER_KEY, String(enabled));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(DATA_SAVER_CHANGE_EVENT, { detail: enabled }));
  } catch {
    // Non-DOM test environments (e.g. node --test) have no window.
  }
}

/**
 * True when the browser itself requests reduced data usage: the
 * `navigator.connection.saveData` flag (driven by the client's `Save-Data`
 * header) or a slow effective connection type. This is an auto-derived
 * signal — it never writes to localStorage, so the manual toggle stays the
 * single source of truth for the stored preference.
 */
export function isBrowserSaveDataEnabled(): boolean {
  try {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!conn) return false;
    if (conn.saveData === true) return true;
    const et = conn.effectiveType;
    return et === 'slow-2g' || et === '2g' || et === '3g';
  } catch {
    return false;
  }
}

/**
 * Effective data-saver state used by media/ad/timeline code paths.
 * True when the user toggle is on OR the browser `Save-Data` hint applies.
 */
export function isDataSaverEnabled(): boolean {
  return getDataSaverMode() || isBrowserSaveDataEnabled();
}

export const TIMELINE_PAGE_SIZE_NORMAL = 20;
export const TIMELINE_PAGE_SIZE_DATA_SAVER = 10;
export const FOR_YOU_BATCH_SIZE_NORMAL = 100;
export const FOR_YOU_BATCH_SIZE_DATA_SAVER = 30;

/** Posts fetched per timeline page — halved in data-saver mode. */
export function getTimelinePageSize(): number {
  return isDataSaverEnabled() ? TIMELINE_PAGE_SIZE_DATA_SAVER : TIMELINE_PAGE_SIZE_NORMAL;
}

/** Posts fetched per client-side ranking batch — smaller in data-saver mode. */
export function getForYouBatchSize(): number {
  return isDataSaverEnabled() ? FOR_YOU_BATCH_SIZE_DATA_SAVER : FOR_YOU_BATCH_SIZE_NORMAL;
}

/** Ad spacing multiplier — ads are deprioritized, not removed, in data-saver mode. */
export const DATA_SAVER_AD_SPACING_MULTIPLIER = 4;
