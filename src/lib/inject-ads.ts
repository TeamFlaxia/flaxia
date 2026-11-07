import { Ad, TimelineItem } from '../types/post.js';

export function injectAds<T extends TimelineItem>(posts: T[], ads: Ad[], everyN: number): TimelineItem[] {
  if (!ads.length) return posts;
  const shuffled = [...ads].sort(() => Math.random() - 0.5);
  const result: TimelineItem[] = [];
  let adIndex = 0;
  posts.forEach((post, i) => {
    result.push(post);
    if ((i + 1) % everyN === 0) {
      result.push(shuffled[adIndex % shuffled.length]);
      adIndex++;
    }
  });
  return result;
}
