import { Hono } from 'hono';
import { validateImageDimensions } from '../../../lib/image-dimensions';
import { submitFileScans } from '../../../lib/scan/clamav';
import { runInBackground, scanUploadSync } from '../../../lib/scan/index';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';
import { deliverProfileUpdate } from './helpers.ts';

export const avatar = new Hono<{ Bindings: Bindings; Variables: Variables }>();

avatar.post('/users/me/avatar', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const contentType = c.req.header('content-type');
    const contentLength = c.req.header('content-length');

    if (!contentType || !contentLength) {
      return c.json({ error: 'Content-Type and Content-Length headers required' }, 400);
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!contentType || !allowedTypes.includes(contentType as string)) {
      return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400);
    }

    const maxSize = 5 * 1024 * 1024;
    if (Number(contentLength) > maxSize) {
      return c.json({ error: 'Avatar must be ≤5MB' }, 413);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const userId = user.id;

    const fileData = await c.req.arrayBuffer();

    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'Avatar must be ≤5MB' }, 413);
    }

    const detected = detectMimeType(fileData);
    if (!isAllowedImageMime(detected)) {
      return c.json({ error: 'File content does not match allowed image types' }, 400);
    }
    const dimError = validateImageDimensions(fileData, detected);
    if (dimError) {
      return c.json({ error: dimError }, 413);
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', fileData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const existingKey = `avatar/${hashHex}`;

    const verdict = await scanUploadSync(c.env.DB, {
      bytes: fileData,
      declaredType: contentType,
      r2Key: existingKey,
      detectedMime: detected,
    });
    if (!verdict.ok) {
      return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
    }

    const existingObject = await c.env.BUCKET.head(existingKey);

    let avatarKey: string;
    if (existingObject) {
      avatarKey = existingKey;
      console.log('Reusing existing avatar file:', avatarKey);
    } else {
      avatarKey = existingKey;
      await c.env.BUCKET.put(avatarKey, fileData, {
        httpMetadata: {
          contentType: contentType,
        },
      });
      console.log('Uploaded new avatar file:', avatarKey);
    }

    runInBackground(c, () => submitFileScans(c.env.DB, c.env, avatarKey, detected, fileData));

    const result = await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(avatarKey, userId).run();

    if (!result.success) {
      return c.json({ error: 'Failed to update avatar' }, 500);
    }

    deliverProfileUpdate(c, userId);

    return c.json({ success: true, avatar_key: avatarKey });
  } catch (error: unknown) {
    console.error('Avatar upload error:', error);
    return c.json({ error: 'Avatar upload failed' }, 500);
  }
});

// POST /users/:username/follow - follow a user (protected)
