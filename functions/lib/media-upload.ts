import type { Context } from 'hono';
import {
  FREE_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_CHUNKS,
  PLUS_UPLOAD_MAX_BYTES,
  SINGLE_REQUEST_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
} from '../../shared/upload-limits.ts';
import { detectMimeType, isAllowedImageMime } from '../api/helpers';
import type { Bindings, Variables } from '../api/types.ts';
import { type AttachmentKind, MAX_ATTACHMENTS, MAX_ATTACHMENTS_PLUS, parseAttachmentKey } from './attachments';
import { getUserPlan } from './billing';
import { assembleChunks, chunkTempKey, isValidUploadId } from './chunked-upload.ts';
import { validateImageDimensions } from './image-dimensions';
import type { Services } from './ports/index.ts';
import { checkRateLimit, getClientIp } from './rate-limit';
import { submitFileScans } from './scan/clamav';
import { setScanStatus } from './scan/db';
import { scanChunkedUpload, scanUploadSync } from './scan/index';
import { readZipStructureHash } from './scan/zip-range.ts';

type UploadContext = Context<{ Bindings: Bindings; Variables: Variables }>;

function mimeMatchesAttachmentKind(kind: AttachmentKind, mime: string): boolean {
  switch (kind) {
    case 'image':
      return isAllowedImageMime(mime);
    case 'audio':
      // .webm uploads are stored as video/webm or audio/webm depending on the
      // client's content type, so both containers are valid in an audio slot.
      return mime.startsWith('audio/') || mime === 'video/webm' || mime === 'video/mp4';
    case 'video':
      return mime.startsWith('video/');
    case 'document':
      return true;
  }
}

function tooLarge(maxBytes: number): Response {
  return Response.json(
    { error: `File too large. Maximum size is ${maxBytes / (1024 * 1024)}MB`, code: 'file_too_large' },
    { status: 413 },
  );
}

/**
 * Pick a Content-Type that is actually in the requested media class.
 *
 * The stored R2 metadata is attacker-influenced (the uploader chooses the
 * declared type and, for document slots, any sniffed type passes), so the
 * audio/video proxies must never echo an executable type such as text/html
 * back to the browser. Unknown stored types fall back to the key extension;
 * when neither says "audio" (or "video") the route refuses to serve.
 */
export async function handleMediaUpload(c: UploadContext, env: Bindings, services: Services): Promise<Response> {
  try {
    const user = c.get('user')!;
    const key = c.req.path.replace('/api/upload/', '');
    const declaredContentType = c.req.header('content-type');
    const contentLength = c.req.header('content-length');

    if (!key) {
      return c.json({ error: 'Missing file key' }, 400);
    }

    // Keys are path-shaped: reject traversal and unexpected characters
    // before they reach ownership checks or R2.
    if (key.includes('..') || key.includes('\\') || !/^[A-Za-z0-9_./-]+$/.test(key) || key.length > 256) {
      return c.json({ error: 'Invalid key' }, 400);
    }

    // Byte ingest is the most expensive path per request: throttle uploads
    // per user as well as per IP (GET paths are IP-throttled already).
    // Local dev and the test server are exempt: the integration suite uploads
    // dozens of fixtures from a single IP.
    const isLocalEnv = env.ENVIRONMENT === 'test' || (env.BASE_URL ?? '').startsWith('http://localhost');
    if (!isLocalEnv) {
      const uploadIp = getClientIp(c.req.raw);
      if (
        !(await checkRateLimit(services.kv, `upload:user:${user.id}`, {
          // A 128MB file is 8 part requests plus finalization, so a handful of
          // large attachments in one post can legitimately exceed 20 requests.
          maxRequests: 60,
          windowSeconds: 60,
        })) ||
        !(await checkRateLimit(services.kv, `upload:ip:${uploadIp}`, {
          maxRequests: 240,
          windowSeconds: 60,
        }))
      ) {
        return c.json({ error: 'Rate limit exceeded' }, 429);
      }
    }

    if (!services.blobs) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // Flaxia+ raises the per-file ceiling to 128MB; free accounts stay at
    // 25MB. The server is authoritative — the client only mirrors this to
    // size the picker.
    const plan = await getUserPlan({ DB: services.db }, user.id);
    const maxBytes = plan.isActive ? PLUS_UPLOAD_MAX_BYTES : FREE_UPLOAD_MAX_BYTES;

    // Multi-media attachment keys: gif|audio|video/{postId}/{position}{ext}
    const attachment = parseAttachmentKey(key);
    // Enforce the same plan ceiling as prepare/commit before consuming a body
    // or writing a forged, out-of-plan attachment slot into R2.
    if (attachment) {
      const allowedSlots = plan.isActive ? MAX_ATTACHMENTS_PLUS : MAX_ATTACHMENTS;
      if (attachment.position > allowedSlots) {
        return c.json({ error: 'Attachment position exceeds your plan limit' }, 403);
      }
    }

    // Verify the user owns a pending or published post with this storage key
    // For published posts, extract the postId from the key path to verify ownership
    const ownedPost = (await services.db
      .prepare(
        'SELECT id FROM posts WHERE user_id = ? AND (gif_key = ? OR payload_key = ? OR swf_key = ?) AND status = ?',
      )
      .bind(user.id, key, key, key, 'pending')
      .first()) as { id: string } | null;

    if (!ownedPost) {
      if (attachment) {
        // Multi-media attachment keys: gif|audio|video/{postId}/{position}{ext}.
        // The row is only written at commit time, so ownership is verified
        // against the post itself (pending during upload, published on edit).
        const attachmentPost = (await services.db
          .prepare('SELECT id FROM posts WHERE id = ? AND user_id = ? AND status IN (?, ?)')
          .bind(attachment.postId, user.id, 'pending', 'published')
          .first()) as { id: string } | null;
        if (!attachmentPost) {
          return c.json({ error: 'No post found for this key' }, 403);
        }
      } else if (key.startsWith('versions/')) {
        // Versioned game uploads live under versions/<postId>/<versionId>.zip
        // (#86). The tail is not free-form: prepare mints UUID version ids,
        // so anything else is an orphan-storage write and is rejected.
        const parts = key.split('/');
        const postId = parts[1];
        const tail = parts[2];
        if (!postId || parts.length !== 3 || !/^[0-9a-fA-F-]{36}\.zip$/.test(tail || '')) {
          return c.json({ error: 'Invalid key' }, 400);
        }
        const publishedPost = (await services.db
          .prepare('SELECT id FROM posts WHERE id = ? AND user_id = ? AND status = ?')
          .bind(postId, user.id, 'published')
          .first()) as { id: string } | null;
        if (!publishedPost) {
          return c.json({ error: 'No published post found for this key' }, 403);
        }
      } else {
        // Check if user owns a published post (for editing attachments)
        const slashIndex = key.indexOf('/');
        if (slashIndex !== -1) {
          const afterSlash = key.substring(slashIndex + 1);
          const keyPostId = afterSlash.split('.')[0];
          if (keyPostId) {
            const publishedPost = (await services.db
              .prepare('SELECT id FROM posts WHERE id = ? AND user_id = ? AND status = ?')
              .bind(keyPostId, user.id, 'published')
              .first()) as { id: string } | null;
            if (!publishedPost) {
              return c.json({ error: 'No pending post found for this key' }, 403);
            }
          } else {
            return c.json({ error: 'Invalid key' }, 400);
          }
        } else {
          return c.json({ error: 'Invalid key' }, 400);
        }
      }
    }

    const url = new URL(c.req.url);
    const partParam = url.searchParams.get('part');
    const partsParam = url.searchParams.get('parts');
    const uploadId = url.searchParams.get('uploadId');
    const finalize = url.searchParams.get('finalize') === '1';

    // ── Chunked transport ────────────────────────────────────────────────
    // One request per 16MB part, then a finalize request that streams the
    // parts into the destination object. Needed for anything above the
    // single-request ceiling (Cloudflare caps bodies at 100MB).
    if (partParam !== null || finalize) {
      if (!isValidUploadId(uploadId)) {
        return c.json({ error: 'Invalid upload id' }, 400);
      }
      const partCount = Number(partsParam);
      if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_UPLOAD_CHUNKS) {
        return c.json({ error: 'Invalid chunk count' }, 400);
      }

      if (finalize) {
        const parts: Array<{ key: string; size: number }> = [];
        for (let index = 1; index <= partCount; index += 1) {
          const tempKey = chunkTempKey(user.id, uploadId, index);
          const head = await services.blobs.head(tempKey);
          if (!head) {
            return c.json({ error: 'Upload part missing', code: 'upload_part_missing' }, 409);
          }
          parts.push({ key: tempKey, size: head.size });
        }
        const discardParts = () =>
          services.blobs
            .delete(parts.map((part) => part.key))
            .catch((error) => console.error('Failed to delete upload chunks:', error));

        let assembled: Awaited<ReturnType<typeof assembleChunks>>;
        let detectedMime: string | null = null;
        try {
          // The header carries the magic bytes the assembly step uses for the
          // detected content type. Reject unknown/incompatible types before
          // streaming any bytes into the destination key.
          const firstPart = await services.blobs.get(parts[0].key, {
            range: { offset: 0, length: Math.min(64 * 1024, parts[0].size) },
          });
          if (!firstPart) {
            await discardParts();
            return c.json({ error: 'Upload part missing', code: 'upload_part_missing' }, 409);
          }
          const header = new Uint8Array(await new Response(firstPart.body).arrayBuffer());
          const detected = detectMimeType(header);
          detectedMime = detected;
          if (!detected) {
            await discardParts();
            return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400);
          }
          if (
            !isAllowedImageMime(detected) &&
            !detected.startsWith('audio/') &&
            !detected.startsWith('video/') &&
            detected !== 'application/pdf' &&
            detected !== 'application/octet-stream' &&
            detected !== 'application/zip' &&
            detected !== 'application/x-shockwave-flash' &&
            detected !== 'text/html'
          ) {
            await discardParts();
            return c.json({ error: 'File type not allowed' }, 400);
          }
          if (detected === 'application/pdf' && attachment?.kind !== 'document') {
            await discardParts();
            return c.json({ error: 'PDF files are only allowed as document attachments' }, 400);
          }
          if (attachment && !mimeMatchesAttachmentKind(attachment.kind, detected)) {
            await discardParts();
            return c.json({ error: 'File type does not match attachment type' }, 400);
          }
          const dimError = validateImageDimensions(header, detected);
          if (dimError) {
            await discardParts();
            return c.json({ error: dimError }, 413);
          }
          assembled = await assembleChunks(services.blobs, {
            parts,
            destKey: key,
            contentType: detected,
            maxBytes,
          });
        } catch (error: unknown) {
          if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
            return c.json({ error: error.message }, error.status as 400);
          }
          throw error;
        }

        const structureHash =
          detectedMime === 'application/zip' ? await readZipStructureHash(services.blobs, key, assembled.size) : null;
        const verdict = await scanChunkedUpload(services.db, {
          sha256: assembled.sha256,
          header: assembled.header,
          name: key,
          r2Key: key,
          structureHash,
        });
        if (!verdict.ok) {
          await services.blobs.delete(key).catch(() => undefined);
          return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
        }

        // ClamAV cannot scan >25MB sources yet; record an explicit skip so
        // the file is not left permanently pending.
        services.tasks.waitUntil(
          setScanStatus(services.db, key, 'skipped', {
            detail: 'too_large',
            sha256: assembled.sha256,
          }).catch((error) => console.error('Failed to record scan skip:', error)),
        );

        return c.json({ success: true, key });
      }

      const part = Number(partParam);
      if (!Number.isInteger(part) || part < 1 || part > partCount) {
        return c.json({ error: 'Invalid chunk index' }, 400);
      }
      if (contentLength && Number(contentLength) > UPLOAD_CHUNK_BYTES) {
        return c.json({ error: 'Upload chunk too large' }, 413);
      }
      const chunk = await c.req.arrayBuffer();
      if (chunk.byteLength === 0 || chunk.byteLength > UPLOAD_CHUNK_BYTES) {
        return c.json({ error: 'Upload chunk too large' }, 413);
      }
      await services.blobs.put(chunkTempKey(user.id, uploadId, part), chunk, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      return c.json({ success: true, part });
    }

    // ── Single-request transport ─────────────────────────────────────────
    // Keep each body comfortably below Cloudflare's zone upload cap and the
    // isolate memory limit; larger files must use the chunked transport.
    const singleMax = Math.min(maxBytes, SINGLE_REQUEST_UPLOAD_MAX_BYTES);
    if (contentLength && Number(contentLength) > singleMax) {
      return Response.json(
        {
          error: `File is too large for a single request. Maximum size is ${singleMax / (1024 * 1024)}MB`,
          code: 'chunked_upload_required',
        },
        { status: 413 },
      );
    }

    // Get the file data from request body
    const fileData = await c.req.arrayBuffer();

    // Double-check file size after reading
    if (fileData.byteLength > singleMax) {
      return tooLarge(singleMax);
    }
    if (fileData.byteLength > maxBytes) {
      return tooLarge(maxBytes);
    }

    // Validate magic bytes against declared content type. Document formats can
    // use browser MIME values that differ from their container signature (for
    // example, office files are ZIP containers), and unknown formats have no
    // signature to compare. Their extension, magic-byte, and blocklist checks
    // still run below.
    const sniffedMime = detectMimeType(fileData);
    const isDocumentAttachment = attachment?.kind === 'document';
    const detectedMime = sniffedMime ?? (isDocumentAttachment ? 'application/octet-stream' : null);
    if (!detectedMime) {
      return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400);
    }
    // Disallow SVG disguised as other types (SVG has no unique magic bytes, would fail detection above)
    if (
      !isAllowedImageMime(detectedMime) &&
      !detectedMime.startsWith('audio/') &&
      !detectedMime.startsWith('video/') &&
      detectedMime !== 'application/pdf' &&
      detectedMime !== 'application/octet-stream' &&
      detectedMime !== 'application/zip' &&
      detectedMime !== 'application/x-shockwave-flash' &&
      detectedMime !== 'text/html'
    ) {
      return c.json({ error: 'File type not allowed' }, 400);
    }
    // PDFs live only in a multi-media document slot (docs/{postId}/{n}.pdf).
    // The legacy gif/payload/swf keys feed other renderers and are never
    // served by /api/documents, so bytes stored there would be unreachable,
    // and this route is the only place that can tell what the file actually
    // is — the key and the declared Content-Type both come from the client.
    if (detectedMime === 'application/pdf' && attachment?.kind !== 'document') {
      return c.json({ error: 'PDF files are only allowed as document attachments' }, 400);
    }
    // Sanity check: declared content-type should be consistent (relaxed for zip/swf which may use generic types)
    // — replaced by the full scan pipeline below, which checks the declared
    // type, the key extension, the features and the blocklist in one place.

    // Multi-media attachment slots only accept media of the declared kind.
    // This rejects html/swf/zip masquerading in gif|audio|video|docs keys.
    if (attachment) {
      const kindMatches = mimeMatchesAttachmentKind(attachment.kind, detectedMime);
      if (!kindMatches) {
        return c.json({ error: 'File type does not match attachment type' }, 400);
      }
    }

    // Reject oversized images to prevent renderer OOM crashes when decoded in the browser
    const dimError = validateImageDimensions(fileData, detectedMime);
    if (dimError) {
      return c.json({ error: dimError }, 413);
    }

    // Steps 2-4 of the file scanning pipeline: masquerade checks, feature
    // extraction and the synchronous blocklist match. A hit never reaches R2.
    const verdict = await scanUploadSync(services.db, {
      bytes: fileData,
      declaredType: isDocumentAttachment ? undefined : declaredContentType,
      name: key,
      r2Key: key,
      detectedMime,
    });
    if (!verdict.ok) {
      return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
    }

    // Upload to R2 with detected content type
    await services.blobs.put(key, fileData, {
      httpMetadata: {
        contentType: detectedMime,
      },
    });

    // Step 1 (ClamAV) runs after the response; a later hit blocks serving.
    services.tasks.waitUntil(
      Promise.resolve().then(() =>
        submitFileScans(
          services.db as Parameters<typeof submitFileScans>[0],
          env as Parameters<typeof submitFileScans>[1],
          key,
          detectedMime,
          fileData,
        ),
      ),
    );

    return c.json({ success: true, key });
  } catch (error: unknown) {
    console.error('Upload error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
}
