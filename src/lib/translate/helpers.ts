// Pure helpers for the translation page, shared with its tests.
import { buildPlamoPrompt, translateModelFor } from '../../../shared/translate-languages.ts';
import type { LocalAiInferencePayload } from '../crowd-node.ts';

export function normalizeTranslateOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0) {
    const first = output[0] as unknown;
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      const rec = first as Record<string, unknown>;
      const value = rec.translation_text ?? rec.generated_text ?? rec.translated_text ?? rec.text;
      if (typeof value === 'string') return value;
    }
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    const value = rec.translation_text ?? rec.generated_text ?? rec.translated_text ?? rec.text ?? rec.output;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return String(value[0]);
  }
  return String(output ?? '');
}

export function localPayload(text: string, sourceLang: string, targetLang: string): LocalAiInferencePayload {
  const { model, task } = translateModelFor(sourceLang, targetLang);
  return {
    task,
    model,
    input: buildPlamoPrompt(text, sourceLang, targetLang),
    options: { max_new_tokens: 512, do_sample: false, ondeviceOnly: true },
  };
}

export function pollRemote(jobId: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = async () => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      try {
        const res = await fetch(`/api/translate/status?jobId=${encodeURIComponent(jobId)}`, {
          signal,
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { status?: string; translatedText?: string | null };
        if (data.status === 'done' && data.translatedText) return resolve(data.translatedText);
        if (data.status === 'failed') return reject(new Error('translation failed'));
        if (++attempts > 40) return reject(new Error('translation timed out'));
        setTimeout(tick, 1200);
      } catch (error) {
        reject(error);
      }
    };
    void tick();
  });
}

export function detectSourceLang(text: string): string {
  if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(text)) return 'ja';
  if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  return 'en';
}
