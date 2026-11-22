// Post submission pipeline extracted from the legacy DOM controller so the
// Svelte composer can reuse the exact request/response handling.
import { attachmentMimeType, getMimeType } from '../../../shared/file-extensions.ts';
import type { Post } from '../../../shared/types/post.ts';
import { uploadFileBody } from '../upload.ts';
import type { PollData } from './logic.ts';

interface PreparedUpload {
  key: string;
  uploadUrl: string;
  kind: string;
}

async function preparePost(selectedFile: File): Promise<{ postId: string; upload: PreparedUpload }> {
  const contentType = selectedFile.type || getMimeType(selectedFile.name);
  const response = await fetch('/api/posts/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ filename: selectedFile.name, contentType }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Failed to prepare post'));
  const result = (await response.json()) as {
    postId: string;
    uploadUrl?: string;
    gifKey?: string;
    zipKey?: string;
    zipUploadUrl?: string;
    swfKey?: string;
    swfUploadUrl?: string;
    gifUploadUrl?: string;
  };
  if (!result.postId) throw new Error('Invalid prepare response');
  const upload: PreparedUpload =
    result.zipKey && result.zipUploadUrl
      ? { key: result.zipKey, uploadUrl: result.zipUploadUrl, kind: 'zip' }
      : result.swfKey && result.swfUploadUrl
        ? { key: result.swfKey, uploadUrl: result.swfUploadUrl, kind: 'swf' }
        : { key: result.gifKey ?? '', uploadUrl: result.gifUploadUrl ?? '', kind: 'gif' };
  return { postId: result.postId, upload };
}

async function prepareAttachments(files: File[]): Promise<{ postId: string; uploads: PreparedUpload[] }> {
  const response = await fetch('/api/posts/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      files: files.map((file) => ({ filename: file.name, contentType: file.type || getMime(file.name) })),
    }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Failed to prepare post'));
  const result = (await response.json()) as { postId: string; uploads: PreparedUpload[] };
  if (!result.postId || !Array.isArray(result.uploads)) throw new Error('Invalid prepare response');
  return result;
}

async function uploadFile(file: File, uploadUrl: string): Promise<boolean> {
  return uploadFileBody(file, uploadUrl, file.type || getMime(file.name));
}

function getMime(name: string): string {
  return attachmentMimeType(name) || 'application/octet-stream';
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) message += `: ${body.error}`;
  } catch {
    const text = await response.text().catch(() => '');
    if (text) message += `: ${text.slice(0, 200)}`;
  }
  return message;
}

function extractHashtags(text: string): string[] {
  const regex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
  const tags = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) tags.add(match[1]);
  return [...tags];
}

export interface SubmitInput {
  text: string;
  selectedFile: File | null;
  selectedMedia: File[];
  selectedThumbnail: File | null;
  poll: PollData | null;
  quotedPostId?: string;
}

export async function submitPost(input: SubmitInput): Promise<Post> {
  let postId: string | undefined;
  let gifKey: string | undefined;
  let zipKey: string | undefined;
  let swfKey: string | undefined;
  let attachments: Array<{ key: string; kind: string }> | undefined;

  if (input.selectedMedia.length > 0) {
    const prepared = await prepareAttachments(input.selectedMedia);
    postId = prepared.postId;
    const results = await Promise.all(prepared.uploads.map((u, i) => uploadFile(input.selectedMedia[i], u.uploadUrl)));
    if (results.some((ok) => !ok)) throw new Error('Failed to upload files');
    attachments = prepared.uploads.map((u) => ({ key: u.key, kind: u.kind }));
  } else if (input.selectedFile) {
    const prepared = await preparePost(input.selectedFile);
    postId = prepared.postId;
    const ok = await uploadFile(input.selectedFile, prepared.upload.uploadUrl);
    if (!ok) throw new Error('Failed to upload file');
    if (prepared.upload.kind === 'zip') zipKey = prepared.upload.key;
    else if (prepared.upload.kind === 'swf') swfKey = prepared.upload.key;
    else gifKey = prepared.upload.key;
  }

  if (input.selectedThumbnail) {
    const form = new FormData();
    form.append('text', input.text);
    if (postId) form.append('postId', postId);
    if (gifKey) form.append('gifKey', gifKey);
    if (zipKey) form.append('payloadKey', zipKey);
    if (swfKey) form.append('swfKey', swfKey);
    form.append('thumbnail', input.selectedThumbnail);
    if (input.poll) form.append('poll', JSON.stringify(input.poll));
    if (input.quotedPostId) form.append('quotedPostId', input.quotedPostId);
    const response = await fetch('/api/posts/commit', { method: 'POST', credentials: 'include', body: form });
    if (!response.ok) throw new Error(await errorMessage(response, 'Failed to create post'));
    return (await response.json()) as { post: Post }['post'];
  }

  const response = await fetch('/api/posts/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      postId: postId || crypto.randomUUID(),
      gifKey,
      zipKey,
      swfKey,
      attachments,
      text: input.text,
      hashtags: extractHashtags(input.text),
      poll: input.poll || undefined,
      quotedPostId: input.quotedPostId,
    }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Failed to commit post'));
  return (await response.json()) as { post: Post }['post'];
}
