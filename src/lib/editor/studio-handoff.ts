const pendingHandoffs = new Map<string, File[]>();

/** Pass local files between Studio and the timeline without writing plaintext to storage. */
export function saveStudioHandoff(files: File[]): string {
  if (files.length === 0) throw new Error('Select an asset before creating a post');
  const token = crypto.randomUUID();
  pendingHandoffs.set(token, files);
  window.setTimeout(() => pendingHandoffs.delete(token), 10 * 60 * 1000);
  return token;
}

/** Take the same-tab handoff once; the token cannot restore files after a reload. */
export function consumeStudioHandoff(token: string): File[] {
  const files = pendingHandoffs.get(token) ?? [];
  pendingHandoffs.delete(token);
  return files;
}
