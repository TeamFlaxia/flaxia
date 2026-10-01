const AUDIO_RECORDING_MIME_PREFERENCES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
] as const;

/** Pick the best browser-native audio format for a MediaRecorder session. */
export function preferredAudioRecordingMimeType(isSupported: (mimeType: string) => boolean): string | null {
  return AUDIO_RECORDING_MIME_PREFERENCES.find(isSupported) ?? null;
}

function recordingExtension(mimeType: string): string {
  switch (mimeType.split(';', 1)[0].trim().toLowerCase()) {
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mpeg':
      return 'mp3';
    default:
      return 'webm';
  }
}

/** Package MediaRecorder chunks into an importable local Studio asset. */
export function createAudioRecordingFile(chunks: readonly Blob[], mimeType: string, createdAt = Date.now()): File {
  const nonEmptyChunks = chunks.filter((chunk) => chunk.size > 0);
  if (nonEmptyChunks.length === 0) throw new Error('No audio was captured');
  const detectedType = mimeType || nonEmptyChunks.find((chunk) => chunk.type)?.type || 'audio/webm';
  const safeTimestamp = Number.isFinite(createdAt) ? Math.max(0, Math.trunc(createdAt)) : Date.now();
  const blob = new Blob(nonEmptyChunks, { type: detectedType });
  return new File([blob], `recording-${safeTimestamp}.${recordingExtension(detectedType)}`, {
    type: detectedType,
    lastModified: safeTimestamp,
  });
}
