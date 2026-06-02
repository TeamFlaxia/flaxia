export interface ShareData {
  url: string;
  title: string;
  text: string;
}

export interface SharePlatform {
  name: string;
  icon: string;
  color: string;
  getUrl: (data: ShareData) => string;
}

const BASE_URL = typeof window !== 'undefined' ? window.location.origin : 'https://flaxia.app';

export function getPostUrl(postId: string): string {
  return `${BASE_URL}/thread/${postId}`;
}

export function generateShareText(postText: string, maxLength: number = 280): string {
  const cleanedText = postText.replace(/\n+/g, ' ').trim();
  if (cleanedText.length <= maxLength) {
    return cleanedText;
  }
  return cleanedText.substring(0, maxLength - 3) + '...';
}

export function createShareData(post: {
  id: string;
  text: string;
  username: string;
  display_name?: string;
}): ShareData {
  return {
    url: getPostUrl(post.id),
    title: `${post.display_name || post.username} on Flaxia`,
    text: generateShareText(post.text),
  };
}

export const sharePlatforms: SharePlatform[] = [
  {
    name: 'X',
    icon: '𝕏',
    color: '#000000',
    getUrl: (data) =>
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(data.text)}&url=${encodeURIComponent(data.url)}`,
  },
  {
    name: 'Facebook',
    icon: 'f',
    color: '#1877F2',
    getUrl: (data) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(data.url)}`,
  },
  {
    name: 'LinkedIn',
    icon: 'in',
    color: '#0A66C2',
    getUrl: (data) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(data.url)}`,
  },
  {
    name: 'Reddit',
    icon: 'r',
    color: '#FF4500',
    getUrl: (data) =>
      `https://www.reddit.com/submit?url=${encodeURIComponent(data.url)}&title=${encodeURIComponent(data.title)}`,
  },
  {
    name: 'Bluesky',
    icon: '🦋',
    color: '#0085FF',
    getUrl: (data) =>
      `https://bsky.app/intent/compose?text=${encodeURIComponent(data.text)}%20${encodeURIComponent(data.url)}`,
  },
  {
    name: 'Threads',
    icon: '@',
    color: '#000000',
    getUrl: (data) =>
      `https://www.threads.net/intent/post?text=${encodeURIComponent(data.text)}%20${encodeURIComponent(data.url)}`,
  },
];

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textArea);
    }
  }
}

export function canUseWebShare(): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

export async function shareViaWebShare(data: ShareData): Promise<boolean> {
  if (!canUseWebShare()) {
    return false;
  }

  try {
    await navigator.share({
      title: data.title,
      text: data.text,
      url: data.url,
    });
    return true;
  } catch {
    return false;
  }
}
