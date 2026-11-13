// Encrypted personal recommendation profile (docs/e2ee.md).
//
// The preference vector is built and stored entirely in the browser. The
// server only supplies the user's own interaction signals plus embeddings of
// public posts; it never receives the resulting vector.

import { normalizeVector, weightedMeanVector } from '../recommendation/vector.ts';
import { decodeVector, type EncodedVector, RECOMMENDATION_VECTOR_DIM } from '../recommendation/vector-codec.ts';
import { listVaultItems, saveVaultItem } from './items.ts';
import { isVaultUnlocked, subscribeVault } from './session.ts';

export const RECOMMENDATION_PROFILE_ITEM_ID = 'reco-profile-v1';
const PROFILE_TTL_MS = 15 * 60 * 1000;
const DIRTY_STORAGE_KEY = 'flaxia:reco-profile-dirty:v1';

export interface RecommendationProfile {
  v: 1;
  dim: number;
  vector: number[];
  sourceCount: number;
  sourceVersion: string;
  builtAt: string;
  model: 'weighted-mean-v1';
}

interface ProfileSource {
  post_id: string;
  kind: string;
  weight: number;
  created_at?: string;
  vector?: EncodedVector;
}

interface ProfileSourcesResponse {
  v?: number;
  dim?: number;
  encoding?: string;
  sources?: ProfileSource[];
  source_version?: string;
}

let cached: { profile: RecommendationProfile; loadedAt: number } | null = null;
let inflight: Promise<RecommendationProfile | null> | null = null;

subscribeVault(() => {
  if (!isVaultUnlocked()) {
    cached = null;
    inflight = null;
  }
});

export function markRecommendationProfileDirty(): void {
  try {
    localStorage.setItem(DIRTY_STORAGE_KEY, '1');
  } catch {
    // Storage can be unavailable in private mode; the TTL still refreshes it.
  }
}

function isDirty(): boolean {
  try {
    return localStorage.getItem(DIRTY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function clearDirty(): void {
  try {
    localStorage.removeItem(DIRTY_STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the TTL still refreshes the profile.
  }
}

function isValidProfile(value: unknown): value is RecommendationProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<RecommendationProfile>;
  if (profile.v !== 1 || profile.model !== 'weighted-mean-v1') return false;
  if (!Number.isInteger(profile.dim) || (profile.dim ?? 0) < 1 || (profile.dim ?? 0) > 4096) return false;
  if (!Array.isArray(profile.vector) || profile.vector.length !== profile.dim) return false;
  if (!profile.vector.every((value) => Number.isFinite(value))) return false;
  if (!Number.isInteger(profile.sourceCount) || (profile.sourceCount ?? 0) < 0) return false;
  if (typeof profile.sourceVersion !== 'string' || typeof profile.builtAt !== 'string') return false;
  return true;
}

async function readStoredProfile(): Promise<RecommendationProfile | null> {
  try {
    const items = await listVaultItems<RecommendationProfile>('recommendation_profile');
    const item = items.find((entry) => entry.id === RECOMMENDATION_PROFILE_ITEM_ID);
    return item && isValidProfile(item.value) ? item.value : null;
  } catch {
    return null;
  }
}

async function fetchSources(): Promise<ProfileSourcesResponse | null> {
  try {
    const response = await fetch('/api/recommendations/profile-sources', { credentials: 'include' });
    if (!response.ok) return null;
    return (await response.json()) as ProfileSourcesResponse;
  } catch {
    return null;
  }
}

function buildProfile(response: ProfileSourcesResponse): RecommendationProfile | null {
  const dim = Number(response.dim);
  const sources = Array.isArray(response.sources) ? response.sources : [];
  if (!Number.isInteger(dim) || dim < 1 || dim > 4096 || sources.length === 0) return null;

  const decoded = sources
    .map((source) => ({
      vector: decodeVector(source.vector, dim),
      weight: Number(source.weight),
    }))
    .filter(
      (source): source is { vector: number[]; weight: number } =>
        source.vector !== null && Number.isFinite(source.weight) && source.weight > 0,
    );

  const vector = weightedMeanVector(decoded, dim);
  if (!vector) return null;

  return {
    v: 1,
    dim,
    vector: normalizeVector(vector),
    sourceCount: decoded.length,
    sourceVersion: typeof response.source_version === 'string' ? response.source_version : '',
    builtAt: new Date().toISOString(),
    model: 'weighted-mean-v1',
  };
}

async function rebuildProfile(): Promise<RecommendationProfile | null> {
  const response = await fetchSources();
  if (!response) return null;
  const profile = buildProfile(response);
  if (!profile) return null;

  try {
    await saveVaultItem(RECOMMENDATION_PROFILE_ITEM_ID, 'recommendation_profile', profile);
  } catch {
    // A version conflict means another device rotated the envelope. The
    // in-memory vector is still valid for this session; the next unlock
    // rebuilds and saves it again.
  }
  return profile;
}

/**
 * Return the decrypted profile, rebuilding it when stale/dirty. A locked vault
 * or missing signal history yields null, which callers treat as "show the
 * server-side feed" rather than an error.
 */
export async function getRecommendationProfile(
  options: { force?: boolean } = {},
): Promise<RecommendationProfile | null> {
  if (!isVaultUnlocked()) return null;
  const force = options.force === true;
  const dirty = isDirty();

  if (!force && !dirty && cached && Date.now() - cached.loadedAt < PROFILE_TTL_MS) {
    return cached.profile;
  }

  if (inflight) return inflight;
  inflight = (async () => {
    let stored = force ? null : await readStoredProfile();
    // A profile built for the previous embedding model cannot be compared with
    // the new vectors; rebuild it instead of mixing dimensions.
    if (stored && stored.dim !== RECOMMENDATION_VECTOR_DIM) stored = null;
    // The vault can lock while a read/rebuild is awaiting; never repopulate the
    // in-memory cache after that transition.
    if (!isVaultUnlocked()) return null;
    const storedAge = stored ? Date.now() - Date.parse(stored.builtAt) : Number.POSITIVE_INFINITY;
    if (stored && !force && !dirty && Number.isFinite(storedAge) && storedAge < PROFILE_TTL_MS) {
      cached = { profile: stored, loadedAt: Date.now() };
      return stored;
    }

    const rebuilt = await rebuildProfile();
    if (!isVaultUnlocked()) return null;
    if (rebuilt) {
      clearDirty();
      cached = { profile: rebuilt, loadedAt: Date.now() };
      return rebuilt;
    }

    if (stored) {
      cached = { profile: stored, loadedAt: Date.now() };
      return stored;
    }
    return null;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export { PROFILE_TTL_MS, RECOMMENDATION_VECTOR_DIM };
