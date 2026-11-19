import { extractFileFromZip } from '../../../lib/wvfs-zip-server.ts';

// ─── NSFW scanning constants & helpers ────────────────────────────────────────
export const IMAGE_KEY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const IMAGE_EXTENSION_LIKE = IMAGE_KEY_EXTENSIONS.map((ext) => `(lower(gif_key) LIKE '%${ext}')`).join(' OR ');

// ─── Game description extraction ──────────────────────────────────────────────
export async function extractGameDescription(
  bucket: R2Bucket,
  db: D1Database,
  payloadKey: string,
  postId: string,
): Promise<void> {
  try {
    const result = await extractFileFromZip(bucket, payloadKey, 'index.html');
    if (!result) return;
    const decoder = new TextDecoder('utf-8');
    const html = decoder.decode(result.data);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const contentMatch = (attrValue: string): string => {
      const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`, 'i'),
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, 'i'),
      ];
      for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m && m[1].trim()) return m[1].trim();
      }
      return '';
    };

    const metaDesc =
      contentMatch('description') || contentMatch('og:description') || contentMatch('twitter:description');
    const gameDescription = metaDesc || title || '';
    if (gameDescription) {
      const cleaned = gameDescription
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        await db
          .prepare('UPDATE posts SET game_description = ? WHERE id = ?')
          .bind(cleaned.slice(0, 500), postId)
          .run();
      }
    }
  } catch (e) {
    console.error(`Failed to extract game description for post ${postId}:`, e);
  }
}

// ─── Auto-restore helper ──────────────────────────────────────────────────────
export async function autoRestoreIfEligible(db: D1Database, postId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `SELECT id FROM counter_notifications
         WHERE post_id = ? AND status = 'pending' AND restore_at IS NOT NULL AND restore_at <= ?`,
      )
      .bind(postId, now)
      .first();

    if (result) {
      await db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(postId).run();
      await db
        .prepare("UPDATE counter_notifications SET status = ? WHERE post_id = ? AND status = 'pending'")
        .bind('auto_restored', postId)
        .run();
      console.log(`Auto-restored post ${postId} after counter-notification period`);
    }
  } catch (err) {
    console.error('Auto-restore check failed:', err);
  }
}
