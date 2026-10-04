// Step 1 (async): hand uploaded bytes to the Crowd orchestrator's `container`
// workload, which runs ClamAV (and the video keyframe hasher) outside the
// Worker. Results arrive on the `/api/crowd/webhook` callback with
// type=file-scan and are applied by functions/lib/crowd.ts.
//
// Skips are explicit and recorded: without an orchestrator or above the
// payload cap the scan row becomes `skipped` with a reason instead of silently
// staying pending.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type CrowdEnv, crowdConfig, getCrowdClient, signedCallbackUrl } from '../crowd.ts';
import { ensureFileScansTable, getFileScan, setScanStatus, setScanTask, upsertFileScan } from './db.ts';
import { extractFileFeatures } from './features.ts';
import { extensionOf } from './mime.ts';

/**
 * Cap for container payloads. The orchestrator rejects any request body above
 * MAX_PAYLOAD_SIZE (1 MiB in packages/worker/wrangler.toml) and base64 inflates
 * the file by ~4/3, so the effective raw limit is ~768 KiB — far below the
 * 25 MiB the upload path accepts. Sizing this to the real limit turns those
 * uploads into an explicit `skipped/too_large` row instead of a 413 that leaves
 * them unscanned. Raise CROWD_MAX_PAYLOAD_BYTES together with the orchestrator.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
/** Room for the JSON scaffolding around the base64 file. */
const PAYLOAD_SCAFFOLD_BYTES = 4_096;

/** Largest raw file that still fits one task body for the configured cap. */
export function clamavMaxBytes(env?: CrowdEnv): number {
  const configured = Number(env?.CROWD_MAX_PAYLOAD_BYTES ?? '');
  const cap = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PAYLOAD_BYTES;
  return Math.max(0, Math.floor(((cap - PAYLOAD_SCAFFOLD_BYTES) * 3) / 4));
}

/** Default raw-file cap for the stock orchestrator body limit. */
export const CLAMAV_MAX_BYTES = clamavMaxBytes();

/**
 * WASM images the browser node fetches for container tasks. The node rejects
 * bare names and requires HTTPS URLs (it also blocks localhost/private hosts),
 * so these must be full, publicly reachable URLs.
 */
export const CLAMAV_IMAGE_ENV = 'FILE_SCAN_CLAMAV_IMAGE';
export const VIDEO_PHASH_IMAGE_ENV = 'FILE_SCAN_VIDEO_PHASH_IMAGE';

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
    let row = await getFileScan(db, r2Key);
    if (!row) {
      // #85: the sync upsert may have failed while the upload itself passed.
      // Without a row the scan would silently never happen, so rebuild the
      // pending row from the bytes in hand instead of returning early.
      // A row that already reached a terminal state is left alone.
      try {
        const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        await upsertFileScan(db, r2Key, await extractFileFeatures(raw, mime));
        row = await getFileScan(db, r2Key);
      } catch (e) {
        console.error(`File scan row rebuild failed for ${r2Key}:`, e);
        return;
      }
    }
    if (!row || row.status !== 'pending') return;

    const config = crowdConfig(env);
    if (!config.configured) {
      await setScanStatus(db, r2Key, 'skipped', { detail: 'orchestrator_unconfigured', sha256: row.sha256 });
      return;
    }

    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteLength > clamavMaxBytes(env)) {
      await setScanStatus(db, r2Key, 'skipped', { detail: 'too_large', sha256: row.sha256 });
      return;
    }

    // Bind the submission to the bytes we actually hold. The background task
    // may run after the same key has been re-uploaded; using only the row's
    // current sha would scan bytes A while labelling the callback as bytes B,
    // and B would inherit A's verdict.
    const submittedSha = bytesToHex(sha256(raw));
    if (row.sha256 !== submittedSha) return;

    const client = getCrowdClient(config);
    if (!client) return;

    // The sha prefix ties the eventual verdict back to this exact content, so
    // a slow callback cannot mark a re-uploaded file with a stale result.
    const shaPrefix = submittedSha.slice(0, 16);
    const payload = toBase64(raw);
    const ext = extensionOf(r2Key) ?? 'bin';
    const fileName = `input.${ext}`;
    const clamavImage = (env[CLAMAV_IMAGE_ENV] || '').trim();
    if (!clamavImage) {
      // Failing closed here would make every upload unusable until the
      // deployment is configured. Record the configuration gap explicitly so
      // the un-scanned state is visible instead of silently staying pending.
      await setScanStatus(db, r2Key, 'skipped', { detail: 'scan_image_unconfigured', sha256: submittedSha });
      return;
    }

    try {
      const res = await client.submit({
        workload: 'container',
        payload: {
          image: clamavImage,
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
      await setScanTask(db, r2Key, res.taskId, submittedSha);
    } catch (err) {
      console.error(`ClamAV submission failed for ${r2Key}:`, err);
      await setScanStatus(db, r2Key, 'failed', { detail: 'submission_error', sha256: submittedSha });
      return;
    }

    const videoPhashImage = (env[VIDEO_PHASH_IMAGE_ENV] || '').trim();
    if (mime.startsWith('video/') && videoPhashImage) {
      await submitVideoPhash(config, r2Key, shaPrefix, raw, videoPhashImage);
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
  image: string,
): Promise<void> {
  try {
    const client = getCrowdClient(config);
    if (!client) return;
    await client.submit({
      workload: 'container',
      payload: {
        image,
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
