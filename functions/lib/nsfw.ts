import type { NudeNetDetection } from '@flaxia/sdk';

const THRESHOLD = 0.5;

const EXPLICIT_LABELS = new Set(['FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_EXPOSED']);

const ELEMENT_TAGS: Record<string, string> = {
  FEMALE_GENITALIA_EXPOSED: 'exposed_genital',
  MALE_GENITALIA_EXPOSED: 'exposed_genital',
  ANUS_EXPOSED: 'exposed_anus',
  FEMALE_BREAST_EXPOSED: 'exposed_breast',
  MALE_BREAST_EXPOSED: 'exposed_breast',
  BUTTOCKS_EXPOSED: 'exposed_buttocks',
};

export function resolveNsfwTags(detections: NudeNetDetection[] | undefined): { nsfw: boolean; tags: string[] } {
  if (!detections || detections.length === 0) return { nsfw: false, tags: [] };

  const tags = new Set<string>();
  let nsfw = false;

  for (const det of detections) {
    if (det.score < THRESHOLD) continue;
    if (EXPLICIT_LABELS.has(det.label)) nsfw = true;
    const elementTag = ELEMENT_TAGS[det.label];
    if (elementTag) tags.add(elementTag);
  }

  if (nsfw) tags.add('nsfw');
  return { nsfw, tags: Array.from(tags) };
}

export async function applyNsfwTags(db: D1Database, postId: string, tags: string[]): Promise<boolean> {
  if (tags.length === 0) return false;

  const postRow = (await db.prepare('SELECT hashtags FROM posts WHERE id = ?').bind(postId).first()) as {
    hashtags: string;
  } | null;
  if (!postRow) return false;

  const hashtags: string[] = JSON.parse(postRow.hashtags || '[]');
  const normalized = new Set(hashtags.map((t) => t.toLowerCase()));
  let changed = false;

  for (const tag of tags) {
    if (!normalized.has(tag.toLowerCase())) {
      hashtags.push(tag);
      normalized.add(tag.toLowerCase());
      changed = true;
    }
  }

  if (!changed) return false;

  const result = await db
    .prepare('UPDATE posts SET hashtags = ? WHERE id = ?')
    .bind(JSON.stringify(hashtags), postId)
    .run();
  return result.success;
}
