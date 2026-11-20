// Reply submission pipeline extracted from the legacy DOM controller.
import type { Post } from '../../../shared/types/post.ts';
import { t } from '../i18n.ts';

export class AuthRequiredError extends Error {
  constructor() {
    super(t('reply_composer.error_auth_required'));
  }
}

function extractHashtags(text: string): string[] {
  const regex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
  const tags = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) tags.add(match[1]);
  return [...tags];
}

async function prepareReply(
  postId: string,
  file: File,
): Promise<{ replyId: string; gifUploadUrl: string; gifKey: string }> {
  const response = await fetch(`/api/posts/${postId}/replies/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (!response.ok) throw new Error('Failed to prepare reply');
  return (await response.json()) as { replyId: string; gifUploadUrl: string; gifKey: string };
}

async function uploadFile(file: File, url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
      credentials: 'include',
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function commitReply(
  postId: string,
  replyId: string | undefined,
  gifKey: string | undefined,
  text: string,
): Promise<Post> {
  const response = await fetch(`/api/posts/${postId}/replies/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      replyId: replyId || crypto.randomUUID(),
      gifKey,
      text,
      hashtags: extractHashtags(text),
    }),
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (!response.ok) throw new Error('Failed to commit reply');
  return ((await response.json()) as { reply: Post }).reply;
}

export async function submitReply(postId: string, file: File | null, text: string): Promise<Post> {
  let replyId: string | undefined;
  let gifKey: string | undefined;
  if (file) {
    const prepared = await prepareReply(postId, file);
    replyId = prepared.replyId;
    gifKey = prepared.gifKey;
    if (!(await uploadFile(file, prepared.gifUploadUrl))) throw new Error('Failed to upload file');
  }
  return commitReply(postId, replyId, gifKey, text);
}
