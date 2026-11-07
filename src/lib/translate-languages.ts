/**
 * Supported languages for translation. Codes are M2M100-style so the same
 * value can be passed as `src_lang` / `tgt_lang` to `ai-inference`.
 */
export interface TranslateLanguage {
  code: string;
  jaName: string;
  enName: string;
}

/** M2M100 uses full English names for some codes; we keep short codes here. */
export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: 'en', jaName: '英語', enName: 'English' },
  { code: 'ja', jaName: '日本語', enName: 'Japanese' },
  { code: 'ko', jaName: '韓国語', enName: 'Korean' },
  { code: 'zh', jaName: '中国語', enName: 'Chinese' },
  { code: 'fr', jaName: 'フランス語', enName: 'French' },
  { code: 'de', jaName: 'ドイツ語', enName: 'German' },
  { code: 'es', jaName: 'スペイン語', enName: 'Spanish' },
  { code: 'it', jaName: 'イタリア語', enName: 'Italian' },
  { code: 'pt', jaName: 'ポルトガル語', enName: 'Portuguese' },
  { code: 'ru', jaName: 'ロシア語', enName: 'Russian' },
  { code: 'ar', jaName: 'アラビア語', enName: 'Arabic' },
  { code: 'hi', jaName: 'ヒンディー語', enName: 'Hindi' },
  { code: 'nl', jaName: 'オランダ語', enName: 'Dutch' },
  { code: 'pl', jaName: 'ポーランド語', enName: 'Polish' },
  { code: 'sv', jaName: 'スウェーデン語', enName: 'Swedish' },
  { code: 'tr', jaName: 'トルコ語', enName: 'Turkish' },
  { code: 'vi', jaName: 'ベトナム語', enName: 'Vietnamese' },
  { code: 'th', jaName: 'タイ語', enName: 'Thai' },
  { code: 'id', jaName: 'インドネシア語', enName: 'Indonesian' },
  { code: 'uk', jaName: 'ウクライナ語', enName: 'Ukrainian' },
];

const CODES = new Set(TRANSLATE_LANGUAGES.map((l) => l.code));

export function isTranslateLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && CODES.has(value);
}

export function languageName(code: string, isJa: boolean): string {
  const found = TRANSLATE_LANGUAGES.find((l) => l.code === code);
  if (!found) return code;
  return isJa ? found.jaName : found.enName;
}

/** Translate model id registered in Crowd's `ai-model-registry`. */
export const TRANSLATE_MODEL_ID = 'Xenova/m2m100_418M';
export const TRANSLATE_TASK = 'translation';

/** Local preference for the On-device only toggle. */
const MODE_KEY = 'flaxia_translate_ondevice_only';

export type TranslateMode = 'ondevice-only' | 'off-device-allowed';

export function loadTranslateMode(): TranslateMode {
  try {
    return localStorage.getItem(MODE_KEY) === '1' ? 'ondevice-only' : 'off-device-allowed';
  } catch {
    return 'off-device-allowed';
  }
}

export function saveTranslateMode(mode: TranslateMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode === 'ondevice-only' ? '1' : '0');
  } catch {
    /* ignore */
  }
}
