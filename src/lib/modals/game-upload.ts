// Game upload logic shared by the Svelte modal. Pure helpers are unit tested;
// the request helpers mirror the legacy three-step prepare → PUT → commit flow.
import { getMimeType } from '../../../shared/file-extensions.ts';
import { uploadFileBody } from '../upload.ts';

export const GAME_UPLOAD_EXTS = ['zip', 'html', 'htm'] as const;
export const GAME_THUMBNAIL_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;
export const GAME_THUMBNAIL_MAX_BYTES = 1024 * 1024;

export function fileExtension(name: string): string {
  return name.toLowerCase().split('.').pop() || '';
}

export type GameUploadFileError = 'file_too_large' | 'file_type' | null;

export function gameUploadFileError(file: { name: string; size: number }, maxBytes: number): GameUploadFileError {
  if (file.size > maxBytes) return 'file_too_large';
  if (!(GAME_UPLOAD_EXTS as readonly string[]).includes(fileExtension(file.name))) return 'file_type';
  return null;
}

export type ThumbnailFileError = 'thumbnail_too_large' | 'thumbnail_type' | null;

export function thumbnailFileError(file: { name: string; size: number }): ThumbnailFileError {
  if (file.size > GAME_THUMBNAIL_MAX_BYTES) return 'thumbnail_too_large';
  if (!(GAME_THUMBNAIL_EXTS as readonly string[]).includes(fileExtension(file.name))) return 'thumbnail_type';
  return null;
}

export interface FileSizeParts {
  unit: 'bytes' | 'kb' | 'mb';
  value: string;
}

export function fileSizeParts(bytes: number): FileSizeParts {
  if (bytes < 1024) return { unit: 'bytes', value: String(bytes) };
  if (bytes < 1024 * 1024) return { unit: 'kb', value: (bytes / 1024).toFixed(1) };
  return { unit: 'mb', value: (bytes / (1024 * 1024)).toFixed(1) };
}

const HASHTAG_REGEX = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;

export function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = HASHTAG_REGEX.exec(text)) !== null) {
    tags.add(match[1]);
  }
  return Array.from(tags);
}

export function gameFileTypeLabel(name: string): string {
  return name.toLowerCase().endsWith('.zip') ? ' (HTML5)' : '';
}

export function canSubmitGameUpload(input: { hasFile: boolean; title: string; submitting: boolean }): boolean {
  const title = input.title.trim();
  return input.hasFile && title.length > 0 && title.length <= 200 && !input.submitting;
}

export interface PreparedGamePost {
  postId: string;
  zipKey: string;
  zipUploadUrl: string;
}

export async function prepareGamePost(file: File): Promise<PreparedGamePost | null> {
  try {
    const response = await fetch('/api/posts/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || getMimeType(file.name),
      }),
    });
    if (!response.ok) {
      let errMsg = 'Failed to prepare post';
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody?.error) errMsg += `: ${errBody.error}`;
      } catch {
        // Keep the generic message when the error body is not JSON.
      }
      throw new Error(errMsg);
    }
    const result = (await response.json()) as {
      postId: string;
      zipUploadUrl?: string;
      zipKey?: string;
      swfUploadUrl?: string;
      swfKey?: string;
      gifUploadUrl?: string;
      gifKey?: string;
    };
    if (result.zipUploadUrl && result.zipKey) {
      return { postId: result.postId, zipKey: result.zipKey, zipUploadUrl: result.zipUploadUrl };
    }
    if (result.swfUploadUrl && result.swfKey) {
      return { postId: result.postId, zipKey: result.swfKey, zipUploadUrl: result.swfUploadUrl };
    }
    if (result.gifUploadUrl && result.gifKey) {
      return { postId: result.postId, zipKey: result.gifKey, zipUploadUrl: result.gifUploadUrl };
    }
    return null;
  } catch {
    return null;
  }
}

export async function uploadGameFile(file: File, uploadUrl: string): Promise<boolean> {
  return uploadFileBody(file, uploadUrl, getMimeType(file.name));
}

export async function commitGamePost(
  postId: string,
  zipKey: string,
  title: string,
  thumbnail: File | null,
): Promise<boolean> {
  try {
    if (thumbnail) {
      const formData = new FormData();
      formData.append('text', title);
      formData.append('postId', postId);
      formData.append('payloadKey', zipKey);
      formData.append('thumbnail', thumbnail);
      const response = await fetch('/api/posts/commit', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      return response.ok;
    }

    const response = await fetch('/api/posts/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        postId,
        zipKey,
        text: title,
        hashtags: extractHashtags(title),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
