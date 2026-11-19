/**
 * Supported languages for translation. Only PLaMO-supported pairs are routed;
 * unsupported pairs are rejected instead of loading a second model.
 */
export interface TranslateLanguage {
  code: string;
  jaName: string;
  enName: string;
}

/** Short codes used by the PLaMO prompt. */
export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: 'en', jaName: '英語', enName: 'English' },
  { code: 'ja', jaName: '日本語', enName: 'Japanese' },
  { code: 'ko', jaName: '韓国語', enName: 'Korean' },
  { code: 'zh', jaName: '中国語', enName: 'Chinese' },
  { code: 'fr', jaName: 'フランス語', enName: 'French' },
  { code: 'de', jaName: 'ドイツ語', enName: 'German' },
  { code: 'es', jaName: 'スペイン語', enName: 'Spanish' },
  { code: 'it', jaName: 'イタリア語', enName: 'Italian' },
  { code: 'ru', jaName: 'ロシア語', enName: 'Russian' },
  { code: 'ar', jaName: 'アラビア語', enName: 'Arabic' },
  { code: 'hi', jaName: 'ヒンディー語', enName: 'Hindi' },
  { code: 'nl', jaName: 'オランダ語', enName: 'Dutch' },
  { code: 'pl', jaName: 'ポーランド語', enName: 'Polish' },
  { code: 'vi', jaName: 'ベトナム語', enName: 'Vietnamese' },
  { code: 'th', jaName: 'タイ語', enName: 'Thai' },
  { code: 'id', jaName: 'インドネシア語', enName: 'Indonesian' },
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

/** PLaMo 3 Translate 0.8B (ONNX, Transformers.js). The only translate model. */
export const PLAMO_MODEL_ID = 'TeamFlaxia/plamo-3-translate-0.8b-onnx';
export const PLAMO_MODEL_REVISION = '1c8417ee1a72442440ad515b02f99186c81fd08a';
export const PLAMO_TASK = 'text-generation';

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
 * Whether a pair should use PLaMO. Korean as a *source* is excluded:
 * Transformers.js' Unigram encoder ignores `byte_fallback`, so Hangul
 * syllables missing from the vocab (e.g. 녕 in 안녕하세요) become `<unk>`
 * and the model hallucinates (verified locally: ko→en/ja). Korean as a
 * *target* is fine since the model repo's rev 1c8417ee fixed the
 * tokenizer decoder to ByteFallback, so ja→ko now decodes correctly.
 * Languages outside PLaMO's list are not offered for translation.
 */
export function isPlamoSupported(sourceLang: string, targetLang: string): boolean {
  if (sourceLang === 'ko') return false;
  return PLAMO_SUPPORTED.has(sourceLang) && PLAMO_SUPPORTED.has(targetLang);
}

export function translateModelFor(sourceLang: string, targetLang: string): { model: string; task: string } {
  if (!isPlamoSupported(sourceLang, targetLang)) {
    throw new Error('unsupported_language_pair');
  }
  return { model: PLAMO_MODEL_ID, task: PLAMO_TASK };
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
