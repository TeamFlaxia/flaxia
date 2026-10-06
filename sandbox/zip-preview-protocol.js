export const MAX_SANDBOX_ZIP_PREVIEW_BYTES = 10 * 1024 * 1024;

const PREVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function isPreviewId(value) {
  return typeof value === 'string' && PREVIEW_ID_PATTERN.test(value);
}

export function isSandboxZipPreviewMessage(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'PREVIEW_INIT') return isPreviewId(value.requestId);
  return (
    value.type === 'EXECUTE_ZIP' &&
    isPreviewId(value.postId) &&
    value.zipData instanceof ArrayBuffer &&
    value.zipData.byteLength <= MAX_SANDBOX_ZIP_PREVIEW_BYTES
  );
}

export function isParentZipPreviewMessage(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'ZIP_PREVIEW_READY') return isPreviewId(value.requestId);
  if (value.type === 'ZIP_READY') return isPreviewId(value.postId);
  return (
    value.type === 'ZIP_ERROR' &&
    isPreviewId(value.postId) &&
    typeof value.error === 'string' &&
    value.error.length <= 500
  );
}

export function isPreviewFullscreenRequest(value) {
  return isRecord(value) && value.type === 'REQUEST_FULLSCREEN';
}
