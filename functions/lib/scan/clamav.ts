// Step 1 (async): hand uploaded bytes to the Crowd orchestrator's `container`
// workload, which runs ClamAV (and the video keyframe hasher) outside the
// Worker. Results arrive on the `/api/crowd/webhook` callback with
// type=file-scan and are applied by functions/lib/crowd.ts.
//
// Skips are explicit and recorded: without an orchestrator or above the
// payload cap the scan row becomes `skipped` with a reason instead of silently
// staying pending.

import { type CrowdEnv, crowdConfig, getCrowdClient, signedCallbackUrl } from '../crowd.ts';
import { ensureFileScansTable, getFileScan, setScanStatus, setScanTask } from './db.ts';
import { extensionOf } from './mime.ts';

/**
 * Cap for container payloads: bytes are base64-inlined into the task body
 * (~1.37x). 20MB raw keeps the request near 27MB.
 */
export const CLAMAV_MAX_BYTES = 20 * 1024 * 1024;

/** WASM images expected from the orchestrator (documented in docs/file-scanning.md). */
export const CLAMAV_IMAGE = 'clamav.wasm';
export const VIDEO_PHASH_IMAGE = 'flaxia-video-phash.wasm';

const CONTAINER_TIMEOUT_MS = 120_000;

/** Uint8Array -> base64 without Buffer (Workers only expose btoa). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Submit the async scans (ClamAV, plus keyframe pHash for video) for one
 * uploaded object. Must run inside `runInBackground` — the upload response is
 * already on its way.
 */
export async function submitFileScans(
  db: D1Database,
  env: CrowdEnv,
  r2Key: string,
  mime: string,
  bytes: Uint8Array | ArrayBuffer,
): Promise<void> {
  try {
    await ensureFileScansTable(db);
    const row = await getFileScan(db, r2Key);
    if (!row || row.status !== 'pending') return;

    const config = crowdConfig(env);
    if (!config.configured) {
      await setScanStatus(db, r2Key, 'skipped', { detail: 'orchestrator_unconfigured' });
      return;
    }

    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteLength > CLAMAV_MAX_BYTES) {
      await setScanStatus(db, r2Key, 'skipped', { detail: 'too_large' });
      return;
    }

    const client = getCrowdClient(config);
    if (!client) return;

    // The sha prefix ties the eventual verdict back to this exact content, so
    // a slow callback cannot mark a re-uploaded file with a stale result.
    const shaPrefix = row.sha256.slice(0, 16);
    const payload = toBase64(raw);
    const ext = extensionOf(r2Key) ?? 'bin';
    const fileName = `input.${ext}`;

    try {
      const res = await client.submit({
        workload: 'container',
        payload: {
          image: CLAMAV_IMAGE,
          command: ['clamscan', '--infected', '--no-summary', fileName],
          files: { [fileName]: payload },
        },
        callbackUrl: await signedCallbackUrl(config, {
          baseUrl: config.baseUrl,
          type: 'file-scan',
          params: { key: r2Key, kind: 'clamav', sha: shaPrefix },
        }),
        timeoutMs: CONTAINER_TIMEOUT_MS,
      });
      await setScanTask(db, r2Key, res.taskId);
    } catch (err) {
      console.error(`ClamAV submission failed for ${r2Key}:`, err);
      await setScanStatus(db, r2Key, 'failed', { detail: 'submission_error' });
      return;
    }

    if (mime.startsWith('video/')) {
      await submitVideoPhash(config, r2Key, shaPrefix, raw);
    }
  } catch (e) {
    console.error(`File scan submission failed for ${r2Key}:`, e);
  }
}

/** Video keyframe hashing runs as a second container task (best-effort). */
async function submitVideoPhash(
  config: ReturnType<typeof crowdConfig>,
  r2Key: string,
  shaPrefix: string,
  raw: Uint8Array,
): Promise<void> {
  try {
    const client = getCrowdClient(config);
    if (!client) return;
    await client.submit({
      workload: 'container',
      payload: {
        image: VIDEO_PHASH_IMAGE,
        command: ['video-phash', 'input.mp4'],
        files: { 'input.mp4': toBase64(raw) },
      },
      callbackUrl: await signedCallbackUrl(config, {
        baseUrl: config.baseUrl,
        type: 'file-scan',
        params: { key: r2Key, kind: 'video-phash', sha: shaPrefix },
      }),
      timeoutMs: CONTAINER_TIMEOUT_MS,
    });
  } catch (err) {
    // Keyframe hashing degrades to sha256-only matching; never fail the scan.
    console.warn(`Video phash submission failed for ${r2Key}:`, err);
  }
}
