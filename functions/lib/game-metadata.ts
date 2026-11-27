// Extract Arcade metadata from a game's uploaded HTML (ZIP index.html or a
// direct .html payload). Both publish and version commit write the same shape.
import { cleanGameTitle } from '../../shared/game-title.ts';
import { decodeHtmlEntities } from './activitypub/text.ts';
import { extractFileFromZip } from './wvfs-zip-server.ts';

export async function extractGameDescription(
  bucket: R2Bucket,
  db: D1Database,
  payloadKey: string,
  postId: string,
): Promise<void> {
  try {
    let html: string;
    if (payloadKey.endsWith('.zip')) {
      const result = await extractFileFromZip(bucket, payloadKey, 'index.html');
      if (!result) return;
      html = new TextDecoder('utf-8').decode(result.data);
    } else if (payloadKey.endsWith('.html')) {
      const object = await bucket.get(payloadKey);
      if (!object) return;
      html = await object.text();
    } else return;

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    // Strip tags before decoding so `&lt;3` is not mistaken for markup.
    const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, ' ').trim() : '';
    const title = cleanGameTitle(decodeHtmlEntities(rawTitle));

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
    const gameDescription = metaDesc || rawTitle || '';
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
    // '' is the processed sentinel for "no HTML title": the resolver falls
    // back to the post body, and the admin backfill never reselects this row.
    // NULL remains only for games that have not been extracted yet.
    await db.prepare('UPDATE posts SET game_title = ? WHERE id = ?').bind(title, postId).run();
  } catch (e) {
    console.error(`Failed to extract game description for post ${postId}:`, e);
  }
}
