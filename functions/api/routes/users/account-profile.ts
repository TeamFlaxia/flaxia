import { Hono } from 'hono';
import { normalizeNameColor } from '../../../../shared/name-color.ts';
import { validateImageDimensions } from '../../../lib/image-dimensions';
import { submitFileScans } from '../../../lib/scan/clamav';
import { runInBackground, scanUploadSync } from '../../../lib/scan/index';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';
import { deliverProfileUpdate } from './helpers.ts';

export const accountProfile = new Hono<{ Bindings: Bindings; Variables: Variables }>();

accountProfile.patch('/users/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const userId = user.id;
    let display_name: string | undefined;
    let bio: string | undefined;
    let language: string | undefined;
    let ng_words: string[] | undefined;
    let name_color: string | null | undefined;
    let equippedTitleId: string | null | undefined;
    let avatarFile: File | undefined;
    let headerFile: File | undefined;
    let removeHeader = false;

    const contentType = c.req.header('content-type');

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      display_name = (formData.get('display_name') as string | null) || undefined;
      bio = (formData.get('bio') as string | null) || undefined;
      avatarFile = (formData.get('avatar') as File | null) || undefined;
      headerFile = (formData.get('header') as File | null) || undefined;
      removeHeader = formData.get('remove_header') === '1' || formData.get('remove_header') === 'true';

      const rawTitleId = formData.get('equipped_title_id');
      if (rawTitleId !== null) {
        if (typeof rawTitleId !== 'string') {
          return c.json({ error: 'equipped_title_id must be a string' }, 400);
        }
        const trimmed = rawTitleId.trim();
        equippedTitleId = trimmed === '' ? null : trimmed;
      }

      // Absent means "leave unchanged"; an empty string resets to the default.
      const rawNameColor = formData.get('name_color');
      if (typeof rawNameColor === 'string') {
        name_color = rawNameColor.trim() === '' ? null : rawNameColor;
      }

      if (avatarFile && avatarFile.size > 0) {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(avatarFile.type)) {
          return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400);
        }

        if (avatarFile.size > 5 * 1024 * 1024) {
          return c.json({ error: 'Avatar must be ≤5MB' }, 413);
        }

        if (!c.env.BUCKET) {
          return c.json({ error: 'Storage not available' }, 500);
        }

        const fileBuffer = await avatarFile.arrayBuffer();

        const detected = detectMimeType(fileBuffer);
        if (!isAllowedImageMime(detected)) {
          return c.json({ error: 'File content does not match allowed image types' }, 400);
        }
        const dimError = validateImageDimensions(fileBuffer, detected);
        if (dimError) {
          return c.json({ error: dimError }, 413);
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

        const existingKey = `avatar/${hashHex}`;

        const verdict = await scanUploadSync(c.env.DB, {
          bytes: fileBuffer,
          declaredType: avatarFile.type,
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
          await c.env.BUCKET.put(avatarKey, fileBuffer, {
            httpMetadata: {
              contentType: avatarFile.type,
            },
          });
          console.log('Uploaded new avatar file:', avatarKey);
        }

        runInBackground(c, () => submitFileScans(c.env.DB, c.env, avatarKey, detected, fileBuffer));

        await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(avatarKey, userId).run();
      }

      if (headerFile && headerFile.size > 0) {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(headerFile.type)) {
          return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400);
        }

        const maxHeaderSize = 5 * 1024 * 1024;
        if (headerFile.size > maxHeaderSize) {
          return c.json({ error: 'Header image must be ≤5MB' }, 413);
        }

        if (!c.env.BUCKET) {
          return c.json({ error: 'Storage not available' }, 500);
        }

        const fileBuffer = await headerFile.arrayBuffer();
        const detected = detectMimeType(fileBuffer);
        if (!isAllowedImageMime(detected)) {
          return c.json({ error: 'File content does not match allowed image types' }, 400);
        }
        const dimError = validateImageDimensions(fileBuffer, detected);
        if (dimError) {
          return c.json({ error: dimError }, 413);
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

        const existingKey = `header/${hashHex}`;

        const verdict = await scanUploadSync(c.env.DB, {
          bytes: fileBuffer,
          declaredType: headerFile.type,
          r2Key: existingKey,
          detectedMime: detected,
        });
        if (!verdict.ok) {
          return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
        }

        const existingObject = await c.env.BUCKET.head(existingKey);

        let headerKey: string;
        if (existingObject) {
          headerKey = existingKey;
          console.log('Reusing existing header file:', headerKey);
        } else {
          headerKey = existingKey;
          await c.env.BUCKET.put(headerKey, fileBuffer, {
            httpMetadata: {
              contentType: headerFile.type,
            },
          });
          console.log('Uploaded new header file:', headerKey);
        }

        runInBackground(c, () => submitFileScans(c.env.DB, c.env, headerKey, detected, fileBuffer));

        await c.env.DB.prepare('UPDATE users SET header_key = ? WHERE id = ?').bind(headerKey, userId).run();
      } else if (removeHeader) {
        await c.env.DB.prepare('UPDATE users SET header_key = NULL WHERE id = ?').bind(userId).run();
      }
    } else {
      const body = await c.req.json();
      display_name = body.display_name;
      bio = body.bio;
      language = body.language;
      ng_words = body.ng_words;
      if (Object.hasOwn(body, 'equipped_title_id')) {
        if (body.equipped_title_id !== null && typeof body.equipped_title_id !== 'string') {
          return c.json({ error: 'equipped_title_id must be a string or null' }, 400);
        }
        equippedTitleId = body.equipped_title_id === null ? null : body.equipped_title_id.trim() || null;
      }

      if (Object.hasOwn(body, 'name_color')) {
        name_color = body.name_color ?? null;
      }
    }

    if (display_name !== undefined && display_name.length > 50) {
      return c.json({ error: 'Display name must be ≤50 characters' }, 400);
    }

    if (bio !== undefined && bio.length > 200) {
      return c.json({ error: 'Bio must be ≤200 characters' }, 400);
    }

    if (language !== undefined && !['en', 'ja'].includes(language)) {
      return c.json({ error: 'Language must be either "en" or "ja"' }, 400);
    }

    if (name_color !== undefined) {
      // Reviewers get the Flaxia+ badge through /api/me, but a session created
      // before that sync still carries role=reviewer — accept either proof.
      const entitled = user.badge_type === 'flaxia_plus' || user.role === 'reviewer';
      if (!entitled) {
        return c.json({ error: 'Flaxia+ subscription required', code: 'plus_required' }, 403);
      }
      if (name_color !== null) {
        const normalized = normalizeNameColor(name_color);
        if (!normalized) {
          return c.json({ error: 'Invalid name color' }, 400);
        }
        name_color = normalized;
      }
    }

    if (ng_words !== undefined) {
      if (!Array.isArray(ng_words)) {
        return c.json({ error: 'ng_words must be an array' }, 400);
      }
      if (ng_words.length > 100) {
        return c.json({ error: 'Maximum 100 NG words allowed' }, 400);
      }
      for (const word of ng_words) {
        if (typeof word !== 'string') {
          return c.json({ error: 'All NG words must be strings' }, 400);
        }
        if (word.length > 50) {
          return c.json({ error: 'Each NG word must be ≤50 characters' }, 400);
        }
      }
    }

    if (equippedTitleId !== undefined && equippedTitleId !== null) {
      const owned = await c.env.DB.prepare('SELECT 1 FROM user_titles WHERE user_id = ? AND title_id = ?')
        .bind(userId, equippedTitleId)
        .first();
      if (!owned) {
        return c.json({ error: 'Title not owned' }, 403);
      }
    }

    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(display_name);
    }

    if (bio !== undefined) {
      updates.push('bio = ?');
      values.push(bio);
    }

    if (language !== undefined) {
      updates.push('language = ?');
      values.push(language);
    }

    if (ng_words !== undefined) {
      updates.push('ng_words = ?');
      values.push(JSON.stringify(ng_words));
    }

    if (name_color !== undefined) {
      updates.push('name_color = ?');
      values.push(name_color);
    }

    if (equippedTitleId !== undefined) {
      updates.push('equipped_title_id = ?');
      values.push(equippedTitleId);
    }

    if (updates.length > 0) {
      values.push(userId);

      const result = await c.env.DB.prepare(`
        UPDATE users SET ${updates.join(', ')} WHERE id = ?
      `)
        .bind(...values)
        .run();

      if (!result.success) {
        return c.json({ error: 'Failed to update profile' }, 500);
      }
    }

    type UpdatedUserRow = {
      id: string;
      email: string;
      username: string;
      display_name: string | null;
      bio: string | null;
      avatar_key: string | null;
      badge_type: string | null;
      name_color: string | null;
      header_key: string | null;
      language: string | null;
      ng_words: string | null;
      equipped_title_id: string | null;
      title_name: string | null;
      title_name_ja: string | null;
      title_description: string | null;
      title_description_ja: string | null;
      title_icon: string | null;
      created_at: string;
    };

    const updatedUser = await c.env.DB.prepare(`
      SELECT u.id, u.email, u.username, u.display_name, u.bio, u.avatar_key, u.badge_type, u.name_color, u.header_key, u.language, u.ng_words, u.created_at,
             u.equipped_title_id, t.name AS title_name, t.name_ja AS title_name_ja,
             t.description AS title_description, t.description_ja AS title_description_ja, t.icon AS title_icon
      FROM users u
      LEFT JOIN titles t ON t.id = u.equipped_title_id
      WHERE u.id = ?
    `)
      .bind(userId)
      .first<UpdatedUserRow>();

    // A changed profile only reaches peers through an Update activity.
    if (display_name !== undefined || bio !== undefined || (avatarFile && avatarFile.size > 0)) {
      deliverProfileUpdate(c, userId);
    }

    return c.json({
      user: {
        ...updatedUser,
        ng_words: JSON.parse(updatedUser?.ng_words ?? '[]') as string[],
      },
    });
  } catch (error: unknown) {
    console.error('Update profile error:', error);
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// PATCH /users/me/email - update email (protected)
//
// Re-authentication is an SRP proof of the current password
// (`current_srp = {challenge_id, A, M1}` from /api/auth/reauth/start), so the
// password itself never reaches the server. This also fixes SRP-only accounts,
// which previously could not change email at all: they have no `password_hash`
// for the old plaintext path to compare against.
