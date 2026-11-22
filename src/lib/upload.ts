/**
 * Upload transport shared by the composer, replies and the game uploader.
 *
 * Small files go up in one PUT (the historical path). Files above the
 * single-request ceiling are split into 16 MB parts because Cloudflare caps
 * request bodies at 100 MB on Free/Pro zones and a Worker cannot buffer a
 * 128 MB body. Finalization streams the parts into the destination object.
 */

import {
  requiresChunkedUpload,
  SINGLE_REQUEST_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
} from '../../shared/upload-limits.ts';

const PART_ATTEMPTS = 3;

function contentTypeFor(file: File, fallback: string): string {
  return file.type || fallback || 'application/octet-stream';
}

async function putOnce(url: string, body: BodyInit | null, contentType?: string): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    body,
    credentials: 'include',
    ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
  });
}

async function uploadInParts(file: File, uploadUrl: string, contentType: string): Promise<boolean> {
  const parts = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);
  const uploadId = crypto.randomUUID();
  const separator = uploadUrl.includes('?') ? '&' : '?';

  for (let part = 1; part <= parts; part += 1) {
    const start = (part - 1) * UPLOAD_CHUNK_BYTES;
    const chunk = file.slice(start, Math.min(start + UPLOAD_CHUNK_BYTES, file.size));
    const url = `${uploadUrl}${separator}uploadId=${encodeURIComponent(uploadId)}&part=${part}&parts=${parts}`;
    let uploaded = false;
    for (let attempt = 0; attempt < PART_ATTEMPTS && !uploaded; attempt += 1) {
      try {
        const response = await putOnce(url, chunk, contentType);
        uploaded = response.ok;
      } catch {
        uploaded = false;
      }
    }
    if (!uploaded) return false;
  }

  const finalizeUrl = `${uploadUrl}${separator}uploadId=${encodeURIComponent(uploadId)}&parts=${parts}&finalize=1`;
  for (let attempt = 0; attempt < PART_ATTEMPTS; attempt += 1) {
    try {
      const response = await putOnce(finalizeUrl, null);
      if (response.ok) return true;
      // 4xx means the server will not accept this upload; retrying cannot help.
      if (response.status >= 400 && response.status < 500) return false;
    } catch {
      // fall through and retry
    }
  }
  return false;
}

/**
 * Upload one file to a prepared `/api/upload/...` URL. Returns false when the
 * server rejects the bytes; network retries are handled internally.
 */
export async function uploadFileBody(file: File, uploadUrl: string, fallbackContentType = ''): Promise<boolean> {
  const contentType = contentTypeFor(file, fallbackContentType);
  try {
    if (requiresChunkedUpload(file.size)) {
      return await uploadInParts(file, uploadUrl, contentType);
    }
    const response = await putOnce(uploadUrl, file, contentType);
    return response.ok;
  } catch {
    return false;
  }
}

export { SINGLE_REQUEST_UPLOAD_MAX_BYTES, UPLOAD_CHUNK_BYTES };
