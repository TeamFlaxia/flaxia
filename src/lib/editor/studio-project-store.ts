import {
  decryptVaultItem,
  deriveVaultKeBits,
  encryptVaultItem,
  rewrapItemKeyForVaultKey,
  VAULT_KDF_ITERATIONS,
  VAULT_SALT_BYTES,
  type VaultItemCiphertext,
} from '../vault/primitives.ts';
import {
  type AudioTimelineClip,
  audioClipEqSettings,
  audioClipGainEnvelope,
  audioTrackMixSettings,
} from './audio-mixer.ts';
import { normalizeImageLayerAdjustments } from './image-adjustments.ts';

const DATABASE_NAME = 'flaxia-studio';
const DATABASE_VERSION = 3;
const PROJECT_STORE = 'projects';
const CURRENT_PROJECT_KEY = 'current';
const PROJECT_ITEM_ID = 'studio_project';
const MAX_PERSISTED_BYTES = 50 * 1024 * 1024;
const MAX_PORTABLE_BYTES = 70 * 1024 * 1024;
const PORTABLE_ITEM_ID = 'studio_portable_project_v1';
const PORTABLE_MAGIC = new Uint8Array([0x46, 0x58, 0x53, 0x54, 1]);

interface EncryptedProjectRecord extends VaultItemCiphertext {
  savedAt: number;
}

interface FileManifestEntry {
  name: string;
  type: string;
  lastModified: number;
  offset: number;
  size: number;
}

interface StudioProjectManifest {
  files: FileManifestEntry[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
}

export interface StudioVideoClip {
  id: string;
  fileIndex: number;
  start: number;
  sourceStart: number;
  sourceEnd: number;
  speed?: number;
  fit?: 'contain' | 'cover';
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hueDeg?: number;
  blurPx?: number;
  fadeIn?: number;
  fadeOut?: number;
  gain?: number;
  muted?: boolean;
}

export interface StudioImageLayer {
  id: string;
  kind: 'image' | 'text';
  fileIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hueDeg?: number;
  blurPx?: number;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  start?: number;
  end?: number;
  fadeIn?: number;
  fadeOut?: number;
  visible: boolean;
  blend: 'normal' | 'multiply' | 'screen';
  text?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: 'sans-serif' | 'serif' | 'monospace';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      // Earlier Studio prototypes wrote plaintext Files here. Drop those stores
      // as part of the version bump before creating the encrypted format.
      if (event.oldVersion < 3 && database.objectStoreNames.contains('post-handoffs')) {
        database.deleteObjectStore('post-handoffs');
      }
      if (event.oldVersion < 3 && database.objectStoreNames.contains(PROJECT_STORE)) {
        database.deleteObjectStore(PROJECT_STORE);
      }
      if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Studio storage unavailable'));
    request.onblocked = () => reject(new Error('Close other Flaxia tabs to update Studio storage'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(PROJECT_STORE, mode);
      const request = run(tx.objectStore(PROJECT_STORE));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('Studio storage request failed'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('Studio storage transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Studio storage transaction failed'));
    });
  } finally {
    database.close();
  }
}

async function encodeFiles(
  files: File[],
  audioClips: AudioTimelineClip[],
  videoClips: StudioVideoClip[],
  imageLayers: StudioImageLayer[],
): Promise<Uint8Array> {
  if (files.length > 255) throw new Error('Studio projects support up to 255 files');
  const metadata: FileManifestEntry[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_PERSISTED_BYTES - totalBytes) {
      throw new Error('This project is too large for encrypted local storage');
    }
    metadata.push({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      offset: totalBytes,
      size: file.size,
    });
    totalBytes += file.size;
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({ files: metadata, audioClips, videoClips, imageLayers } satisfies StudioProjectManifest),
  );
  const output = new Uint8Array(4 + manifest.length + totalBytes);
  new DataView(output.buffer).setUint32(0, manifest.length);
  output.set(manifest, 4);
  let offset = 4 + manifest.length;
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    output.set(data, offset);
    offset += data.length;
  }
  return output;
}

function decodeFiles(plaintext: Uint8Array): {
  files: File[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
} {
  if (plaintext.length < 4) throw new Error('Invalid encrypted Studio project');
  const manifestSize = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0);
  if (manifestSize > plaintext.length - 4) throw new Error('Invalid encrypted Studio project');
  const manifest = JSON.parse(
    new TextDecoder().decode(plaintext.subarray(4, 4 + manifestSize)),
  ) as StudioProjectManifest;
  const metadata = manifest.files;
  if (!Array.isArray(metadata) || metadata.length > 255 || !Array.isArray(manifest.audioClips)) {
    throw new Error('Invalid encrypted Studio project');
  }
  const payload = plaintext.subarray(4 + manifestSize);
  const files = metadata.map((entry) => {
    if (
      typeof entry.name !== 'string' ||
      typeof entry.type !== 'string' ||
      !Number.isInteger(entry.offset) ||
      !Number.isInteger(entry.size) ||
      entry.offset < 0 ||
      entry.size < 0 ||
      entry.offset + entry.size > payload.length
    ) {
      throw new Error('Invalid encrypted Studio project');
    }
    return new File([payload.slice(entry.offset, entry.offset + entry.size)], entry.name, {
      type: entry.type,
      lastModified: entry.lastModified,
    });
  });
  const audioClips = manifest.audioClips
    .filter(
      (clip) =>
        typeof clip.id === 'string' &&
        Number.isInteger(clip.fileIndex) &&
        clip.fileIndex >= 0 &&
        clip.fileIndex < files.length &&
        Number.isInteger(clip.track) &&
        clip.track >= 0 &&
        Number.isFinite(clip.start) &&
        Number.isFinite(clip.sourceStart) &&
        Number.isFinite(clip.sourceEnd) &&
        Number.isFinite(clip.gain) &&
        typeof clip.muted === 'boolean',
    )
    .map((clip) => ({
      ...clip,
      fadeIn: Number.isFinite(clip.fadeIn) ? Math.max(0, clip.fadeIn) : 0,
      fadeOut: Number.isFinite(clip.fadeOut) ? Math.max(0, clip.fadeOut) : 0,
      pan: Number.isFinite(clip.pan) ? Math.max(-1, Math.min(1, clip.pan)) : 0,
      trackMuted: clip.trackMuted === true,
      trackSolo: clip.trackSolo === true,
      trackGain: audioTrackMixSettings(clip).gain,
      trackPan: audioTrackMixSettings(clip).pan,
      ...audioClipEqSettings(clip),
      gainEnvelope: audioClipGainEnvelope(clip),
    }));
  const videoClips = (Array.isArray(manifest.videoClips) ? manifest.videoClips : [])
    .filter(
      (clip) =>
        typeof clip.id === 'string' &&
        Number.isInteger(clip.fileIndex) &&
        clip.fileIndex >= 0 &&
        clip.fileIndex < files.length &&
        Number.isFinite(clip.start) &&
        Number.isFinite(clip.sourceStart) &&
        Number.isFinite(clip.sourceEnd) &&
        clip.sourceEnd > clip.sourceStart,
    )
    .map((clip) => ({
      ...clip,
      speed: typeof clip.speed === 'number' && Number.isFinite(clip.speed) ? Math.max(0.5, Math.min(2, clip.speed)) : 1,
      fit: clip.fit === 'cover' ? ('cover' as const) : ('contain' as const),
      brightness:
        typeof clip.brightness === 'number' && Number.isFinite(clip.brightness)
          ? Math.max(0, Math.min(200, clip.brightness))
          : 100,
      contrast:
        typeof clip.contrast === 'number' && Number.isFinite(clip.contrast)
          ? Math.max(0, Math.min(200, clip.contrast))
          : 100,
      saturation:
        typeof clip.saturation === 'number' && Number.isFinite(clip.saturation)
          ? Math.max(0, Math.min(200, clip.saturation))
          : 100,
      hueDeg:
        typeof clip.hueDeg === 'number' && Number.isFinite(clip.hueDeg)
          ? Math.max(-180, Math.min(180, clip.hueDeg))
          : 0,
      blurPx:
        typeof clip.blurPx === 'number' && Number.isFinite(clip.blurPx) ? Math.max(0, Math.min(24, clip.blurPx)) : 0,
      fadeIn: typeof clip.fadeIn === 'number' && Number.isFinite(clip.fadeIn) ? Math.max(0, clip.fadeIn) : 0,
      fadeOut: typeof clip.fadeOut === 'number' && Number.isFinite(clip.fadeOut) ? Math.max(0, clip.fadeOut) : 0,
      gain: typeof clip.gain === 'number' && Number.isFinite(clip.gain) ? Math.max(0, Math.min(1, clip.gain)) : 1,
      muted: typeof clip.muted === 'boolean' ? clip.muted : false,
    }));
  const imageLayers = (Array.isArray(manifest.imageLayers) ? manifest.imageLayers : [])
    .filter(
      (layer) =>
        typeof layer.id === 'string' &&
        (layer.kind === 'text'
          ? typeof layer.text === 'string' && layer.text.length <= 2000
          : Number.isInteger(layer.fileIndex) && layer.fileIndex >= 0 && layer.fileIndex < files.length) &&
        Number.isFinite(layer.x) &&
        Number.isFinite(layer.y) &&
        Number.isFinite(layer.width) &&
        layer.width > 0 &&
        layer.width <= 4096 &&
        Number.isFinite(layer.height) &&
        layer.height > 0 &&
        layer.height <= 4096 &&
        (layer.rotation === undefined || Number.isFinite(layer.rotation)) &&
        Number.isFinite(layer.opacity) &&
        typeof layer.visible === 'boolean' &&
        ['normal', 'multiply', 'screen'].includes(layer.blend) &&
        (layer.kind !== 'text' ||
          ((layer.color === undefined || /^#[\da-f]{6}$/i.test(layer.color)) &&
            (layer.fontSize === undefined ||
              (Number.isFinite(layer.fontSize) && layer.fontSize >= 8 && layer.fontSize <= 256)) &&
            (layer.fontFamily === undefined || ['sans-serif', 'serif', 'monospace'].includes(layer.fontFamily)))),
    )
    .map((layer) => {
      const cropX =
        typeof layer.cropX === 'number' && Number.isFinite(layer.cropX) ? Math.max(0, Math.min(0.99, layer.cropX)) : 0;
      const cropY =
        typeof layer.cropY === 'number' && Number.isFinite(layer.cropY) ? Math.max(0, Math.min(0.99, layer.cropY)) : 0;
      const start =
        typeof layer.start === 'number' && Number.isFinite(layer.start)
          ? Math.max(0, Math.min(14_399.9, layer.start))
          : 0;
      return {
        ...layer,
        kind: (layer.kind === 'text' ? 'text' : 'image') as StudioImageLayer['kind'],
        x: Math.max(-8192, Math.min(8192, layer.x)),
        y: Math.max(-8192, Math.min(8192, layer.y)),
        opacity: Math.max(0, Math.min(1, layer.opacity)),
        ...normalizeImageLayerAdjustments(layer),
        cropX,
        cropY,
        cropWidth:
          typeof layer.cropWidth === 'number' && Number.isFinite(layer.cropWidth)
            ? Math.max(0.01, Math.min(1 - cropX, layer.cropWidth))
            : 1 - cropX,
        cropHeight:
          typeof layer.cropHeight === 'number' && Number.isFinite(layer.cropHeight)
            ? Math.max(0.01, Math.min(1 - cropY, layer.cropHeight))
            : 1 - cropY,
        start,
        end:
          typeof layer.end === 'number' && Number.isFinite(layer.end)
            ? Math.max(start + 0.1, Math.min(14_400, layer.end))
            : undefined,
        fadeIn:
          typeof layer.fadeIn === 'number' && Number.isFinite(layer.fadeIn)
            ? Math.max(0, Math.min(30, layer.fadeIn))
            : 0,
        fadeOut:
          typeof layer.fadeOut === 'number' && Number.isFinite(layer.fadeOut)
            ? Math.max(0, Math.min(30, layer.fadeOut))
            : 0,
        rotation: Number.isFinite(layer.rotation) ? Math.max(-3600, Math.min(3600, layer.rotation)) : 0,
      };
    });
  return { files, audioClips, videoClips, imageLayers };
}

/** Export a passphrase-encrypted portable project; the passphrase never leaves this device. */
export async function exportStudioProject(
  files: File[],
  audioClips: AudioTimelineClip[],
  videoClips: StudioVideoClip[],
  imageLayers: StudioImageLayer[],
  passphrase: string,
): Promise<File> {
  if (passphrase.length < 12) throw new Error('Use a passphrase with at least 12 characters');
  const plaintext = await encodeFiles(files, audioClips, videoClips, imageLayers);
  const salt = crypto.getRandomValues(new Uint8Array(VAULT_SALT_BYTES));
  let key: Uint8Array | null = null;
  try {
    key = await deriveVaultKeBits(passphrase, salt, { alg: 'PBKDF2-SHA256', iterations: VAULT_KDF_ITERATIONS });
    const encrypted = await encryptVaultItem(key, PORTABLE_ITEM_ID, plaintext);
    const record = new TextEncoder().encode(JSON.stringify(encrypted));
    const output = new Uint8Array(PORTABLE_MAGIC.length + salt.length + record.length);
    output.set(PORTABLE_MAGIC);
    output.set(salt, PORTABLE_MAGIC.length);
    output.set(record, PORTABLE_MAGIC.length + salt.length);
    return new File([output], 'flaxia-studio-project.flaxia-studio', {
      type: 'application/vnd.flaxia.studio-project',
    });
  } finally {
    plaintext.fill(0);
    key?.fill(0);
  }
}

/** Decrypt and validate a portable project before it can replace the workspace. */
export async function importStudioProject(
  file: File,
  passphrase: string,
): Promise<{
  files: File[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
}> {
  if (file.size > MAX_PORTABLE_BYTES) throw new Error('Studio project exceeds the 50 MB asset limit');
  if (passphrase.length < 1) throw new Error('Enter the project passphrase');
  const input = new Uint8Array(await file.arrayBuffer());
  if (
    input.length < PORTABLE_MAGIC.length + VAULT_SALT_BYTES + 2 ||
    !PORTABLE_MAGIC.every((value, index) => input[index] === value)
  ) {
    throw new Error('This is not a supported Flaxia Studio project');
  }
  const saltStart = PORTABLE_MAGIC.length;
  const salt = input.slice(saltStart, saltStart + VAULT_SALT_BYTES);
  let key: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    const encrypted = JSON.parse(
      new TextDecoder().decode(input.subarray(saltStart + VAULT_SALT_BYTES)),
    ) as Partial<VaultItemCiphertext>;
    if (
      encrypted.item_id !== PORTABLE_ITEM_ID ||
      typeof encrypted.item_key_wrapped !== 'string' ||
      typeof encrypted.payload !== 'string'
    ) {
      throw new Error('Invalid Flaxia Studio project');
    }
    key = await deriveVaultKeBits(passphrase, salt, { alg: 'PBKDF2-SHA256', iterations: VAULT_KDF_ITERATIONS });
    plaintext = await decryptVaultItem(key, PORTABLE_ITEM_ID, encrypted.item_key_wrapped, encrypted.payload);
    return decodeFiles(plaintext);
  } catch {
    throw new Error('Could not open this project. Check the passphrase and file integrity.');
  } finally {
    input.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

/** Persist one encrypted local project. Vault keys never enter IndexedDB. */
export async function saveStudioProject(
  files: File[],
  audioClips: AudioTimelineClip[],
  videoClips: StudioVideoClip[],
  imageLayers: StudioImageLayer[],
  vaultKey: Uint8Array,
): Promise<void> {
  const plaintext = await encodeFiles(files, audioClips, videoClips, imageLayers);
  try {
    const encrypted = await encryptVaultItem(vaultKey, PROJECT_ITEM_ID, plaintext);
    await transaction('readwrite', (store) =>
      store.put({ ...encrypted, savedAt: Date.now() } satisfies EncryptedProjectRecord, CURRENT_PROJECT_KEY),
    );
  } finally {
    plaintext.fill(0);
  }
}

export async function loadStudioProject(vaultKey: Uint8Array): Promise<{
  files: File[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
}> {
  const record = (await transaction('readonly', (store) => store.get(CURRENT_PROJECT_KEY))) as
    | EncryptedProjectRecord
    | undefined;
  if (!record || record.item_id !== PROJECT_ITEM_ID) {
    return { files: [], audioClips: [], videoClips: [], imageLayers: [] };
  }
  const plaintext = await decryptVaultItem(vaultKey, record.item_id, record.item_key_wrapped, record.payload);
  try {
    return decodeFiles(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/** Keep the device-local project readable when the account rotates its VK. */
export async function rewrapStudioProjectKey(oldVk: Uint8Array, newVk: Uint8Array): Promise<void> {
  const record = (await transaction('readonly', (store) => store.get(CURRENT_PROJECT_KEY))) as
    | EncryptedProjectRecord
    | undefined;
  if (!record || record.item_id !== PROJECT_ITEM_ID) return;
  const item_key_wrapped = await rewrapItemKeyForVaultKey(oldVk, newVk, record.item_id, record.item_key_wrapped);
  await transaction('readwrite', (store) => store.put({ ...record, item_key_wrapped }, CURRENT_PROJECT_KEY));
}
