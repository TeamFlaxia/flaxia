export function buildGameTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  const cleaned = firstLine.replace(/^#+\s*/, '');
  return cleaned || 'Untitled Game';
}

export function cleanGameDescription(raw: string, maxLen = 160): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export interface GameDescriptionInput {
  gameDescription?: string | null;
  title: string;
  typeLabel: string;
  authorName: string;
  text?: string;
}

export function buildGameDescription(input: GameDescriptionInput): string {
  const { gameDescription, title, typeLabel, authorName, text } = input;

  if (gameDescription) {
    const cleaned = cleanGameDescription(gameDescription);
    if (cleaned) return cleaned;
  }

  const description = `「${title}」をFlaxia Arcadeでブラウザから直接プレイ。${authorName}が投稿した${typeLabel}ゲーム。`;

  const bodySnippet = text
    ? text
        .split('\n')
        .slice(1)
        .join(' ')
        .replace(/#[\w\u3000-\u9fff\-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';

  if (bodySnippet) {
    const remaining = 200 - description.length;
    if (remaining > 20) {
      return `${description} ${bodySnippet.slice(0, remaining)}`.trim();
    }
  }

  return description;
}
