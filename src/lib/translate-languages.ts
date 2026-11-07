/**
 * Supported languages for translation. Short codes are used for both models;
 * `translateModelFor` selects PLaMO (default) or M2M100 (fallback) per pair.
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

/** PLaMo 3 Translate 0.8B (ONNX, Transformers.js). Default for most pairs. */
export const PLAMO_MODEL_ID = 'TeamFlaxia/plamo-3-translate-0.8b-onnx';
export const PLAMO_MODEL_REVISION = '1d7e8fee47003c9026b97d7796111a054e7e03d2';
export const PLAMO_TASK = 'text-generation';
/** M2M100 fallback for pairs where PLaMO is not usable (see below). */
export const M2M100_MODEL_ID = 'Xenova/m2m100_418M';
export const M2M100_TASK = 'translation';

/** Default model/task (kept for compatibility; prefer translateModelFor). */
export const TRANSLATE_MODEL_ID = PLAMO_MODEL_ID;
export const TRANSLATE_TASK = PLAMO_TASK;

/** Languages PLaMO officially supports (52, from the model card). */
const PLAMO_SUPPORTED = new Set([
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'ca',
  'ceb',
  'de',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'fr',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'it',
  'ja',
  'jv',
  'ka',
  'kk',
  'km',
  'ko',
  'lt',
  'lv',
  'ml',
  'mr',
  'ms',
  'my',
  'ne',
  'nl',
  'pa',
  'pl',
  'ru',
  'si',
  'sk',
  'sl',
  'sr',
  'sw',
  'ta',
  'te',
  'th',
  'tl',
  'ur',
  'uz',
  'vi',
  'zh',
]);

/**
 * Whether a pair should use PLaMO. Korean is excluded in both directions:
 * the ONNX tokenizer has no token for at least one common Hangul syllable
 * (verified locally: ko→en / ko→ja hallucinate, ja→ko emits byte mojibake),
 * while M2M100 handles it correctly. Portuguese, Swedish, Turkish and
 * Ukrainian are not in PLaMO's supported list, so they also fall back.
 */
export function isPlamoSupported(sourceLang: string, targetLang: string): boolean {
  if (sourceLang === 'ko' || targetLang === 'ko') return false;
  return PLAMO_SUPPORTED.has(sourceLang) && PLAMO_SUPPORTED.has(targetLang);
}

export function translateModelFor(sourceLang: string, targetLang: string): { model: string; task: string } {
  return isPlamoSupported(sourceLang, targetLang)
    ? { model: PLAMO_MODEL_ID, task: PLAMO_TASK }
    : { model: M2M100_MODEL_ID, task: M2M100_TASK };
}

/**
 * Build the PFML3 prompt PLaMO expects, mirroring
 * `tokenizer.apply_chat_template([{role:'user',content:text}], {target_lang, source_lang, add_generation_prompt:true, tokenize:false})`
 * in the model repo, with the leading `<|plamo:bos|>` stripped (the pipeline
 * tokenizes with `add_special_tokens=true`). The template rejects text
 * containing reserved `<|plamo:` tokens; callers should reject such input.
 */
export function buildPlamoPrompt(text: string, sourceLang: string, targetLang: string): string {
  const prompt =
    `<|plamo:bos|><|plamo:tag|>dataset<|plamo:msg|>translation` +
    `<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>${sourceLang}<|plamo:msg|>${text}` +
    `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${targetLang}<|plamo:msg|>`;
  return prompt.startsWith('<|plamo:bos|>') ? prompt.slice('<|plamo:bos|>'.length) : prompt;
}

export function hasReservedPlamoTokens(text: string): boolean {
  return text.includes('<|plamo:');
}

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
