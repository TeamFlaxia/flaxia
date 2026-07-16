export const TYPE_WEIGHTS: Record<string, { fresh: number; reply: number; impression: number; dwell: number }> = {
  swf: { fresh: 3.0, reply: 4.0, impression: 0.05, dwell: 1.5 },
  payload: { fresh: 2.0, reply: 2.0, impression: 0.1, dwell: 1.0 },
  text: { fresh: 1.0, reply: 1.5, impression: 0.15, dwell: 0.5 },
};

const LINK_RE = /https?:\/\//i;

export function getContentType(payloadKey: string | null, swfKey: string | null): string {
  if (swfKey) return 'swf';
  if (payloadKey) return 'payload';
  return 'text';
}

export function getTypeWeights(payloadKey: string | null, swfKey: string | null) {
  const type = getContentType(payloadKey, swfKey);
  return TYPE_WEIGHTS[type] || TYPE_WEIGHTS.text;
}

export function computeQualityScore(text: string, hasMedia: boolean, recentPostCount1h: number): number {
  const len = text?.length || 0;
  const textScore = len >= 50 && len <= 280 ? 1.0 : len >= 10 && len <= 500 ? 0.7 : 0.3;
  const mediaScore = hasMedia ? 1.2 : 1.0;
  const linkScore = text && LINK_RE.test(text) ? 0.5 : 1.0;
  const freqScore = recentPostCount1h > 3 ? 0.3 : 1.0;
  return textScore * mediaScore * linkScore * freqScore;
}

export function applyScoringWeights(
  baseScore: number,
  payloadKey: string | null,
  swfKey: string | null,
  qualityScore: number,
): number {
  const weights = getTypeWeights(payloadKey, swfKey);
  const typeFactor =
    (weights.fresh + weights.reply + weights.impression) /
    (TYPE_WEIGHTS.text.fresh + TYPE_WEIGHTS.text.reply + TYPE_WEIGHTS.text.impression);
  return baseScore * qualityScore * typeFactor;
}

export function computeAuthorQuality(params: {
  freshRatio: number;
  replyRate: number;
  accountAgeDays: number;
  hasDisplayName: boolean;
  hasBio: boolean;
  hasAvatar: boolean;
}): number {
  const freshScore = Math.min(params.freshRatio, 1.0) * 0.4;
  const replyScore = Math.min(params.replyRate, 1.0) * 0.3;
  const ageScore = Math.min(params.accountAgeDays / 365, 1.0) * 0.2;
  const completeness = (params.hasDisplayName ? 1 : 0) + (params.hasBio ? 1 : 0) + (params.hasAvatar ? 1 : 0);
  const completenessScore = (completeness / 3) * 0.1;
  return freshScore + replyScore + ageScore + completenessScore;
}
