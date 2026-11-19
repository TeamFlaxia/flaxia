/** Bypass game HTML cached with the old immutable compatibility runtime. */
export function createWvfsGameUrl(
  sandboxOrigin: string,
  postId: string,
  options: { versionId?: string; index?: boolean } = {},
): string {
  const url = new URL(
    `/api/wvfs-zip/${encodeURIComponent(postId)}${options.index ? '/index.html' : ''}`,
    sandboxOrigin,
  );
  url.searchParams.set('runtime', '2');
  if (options.versionId) url.searchParams.set('v', options.versionId);
  return url.toString();
}
