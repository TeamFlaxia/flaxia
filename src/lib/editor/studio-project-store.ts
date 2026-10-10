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
  audioClipGainEnvelopePoints,
  audioClipSpeed,
  audioTrackMixSettings,
} from './audio-mixer.ts';
import { normalizeImageLayerAdjustments } from './image-adjustments.ts';
import { isStudioImageBlendMode, type StudioImageBlendMode } from './image-layer-canvas.ts';

const DATABASE_NAME = 'flaxia-studio';
const DATABASE_VERSION = 3;
const PROJECT_STORE = 'projects';
const CURRENT_PROJECT_KEY = 'current';
const PROJECT_ITEM_ID = 'studio_project';
const PROJECT_DATA_KEY_PREFIX = 'project-data:';
const PROJECT_META_KEY_PREFIX = 'project-meta:';
const PROJECT_ITEM_ID_PREFIX = 'studio_project:';
const PROJECT_META_ITEM_ID_PREFIX = 'studio_project_meta:';
const DEFAULT_PROJECT_NAME = 'Untitled project';
const MAX_PROJECTS = 100;
const MAX_PERSISTED_BYTES = 50 * 1024 * 1024;
const MAX_PORTABLE_BYTES = 70 * 1024 * 1024;
const PORTABLE_ITEM_ID = 'studio_portable_project_v1';
const PORTABLE_MAGIC = new Uint8Array([0x46, 0x58, 0x53, 0x54, 1]);

interface EncryptedProjectRecord extends VaultItemCiphertext {
  savedAt: number;
}

interface ProjectMetadata {
  id: string;
  name: string;
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
  projectName?: string;
  files: FileManifestEntry[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
  videoFormat?: StudioVideoFormat;
}

export interface StudioLocalProjectSummary {
  id: string;
  name: string;
  savedAt: number;
}

export type StudioVideoFormat = 'landscape' | 'square' | 'portrait';
export type StudioVideoTransition = 'fade' | 'wipeleft' | 'wiperight';
export type StudioVideoTrack = 'main' | 'overlay';

export interface StudioVideoClip {
  id: string;
  fileIndex: number;
  start: number;
  sourceStart: number;
  sourceEnd: number;
  track?: StudioVideoTrack;
  speed?: number;
  fit?: 'contain' | 'cover';
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hueDeg?: number;
  blurPx?: number;
  fadeIn?: number;
  fadeOut?: number;
  transitionOut?: number;
  transitionType?: StudioVideoTransition;
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
  blend: StudioImageBlendMode;
  positionLocked?: boolean;
  paintLayer?: boolean;
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

function normalizeProjectId(id: string): string {
  if (id !== 'current' && !/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid local project id');
  return id;
}

function normalizeProjectName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('Enter a project name');
  if (normalized.length > 100) throw new Error('Project names must be 100 characters or fewer');
  return normalized;
}

function projectDataKey(id: string): string {
  return id === 'current' ? CURRENT_PROJECT_KEY : `${PROJECT_DATA_KEY_PREFIX}${id}`;
}

function projectItemId(id: string): string {
  return id === 'current' ? PROJECT_ITEM_ID : `${PROJECT_ITEM_ID_PREFIX}${id}`;
}

function projectMetadataKey(id: string): string {
  return `${PROJECT_META_KEY_PREFIX}${id}`;
}

function projectMetadataItemId(id: string): string {
  return `${PROJECT_META_ITEM_ID_PREFIX}${id}`;
}

async function encryptProjectMetadata(
  metadata: ProjectMetadata,
  vaultKey: Uint8Array,
): Promise<EncryptedProjectRecord> {
  const itemId = projectMetadataItemId(metadata.id);
  const plaintext = new TextEncoder().encode(JSON.stringify(metadata));
  try {
    return { ...(await encryptVaultItem(vaultKey, itemId, plaintext)), savedAt: metadata.savedAt };
  } finally {
    plaintext.fill(0);
  }
}

async function readProjectMetadataRecords(): Promise<{
  keys: IDBValidKey[];
  records: Array<{ key: string; value: EncryptedProjectRecord }>;
}> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(PROJECT_STORE, 'readonly');
      const store = tx.objectStore(PROJECT_STORE);
      const keysRequest = store.getAllKeys();
      const records: Array<{ key: string; value: EncryptedProjectRecord }> = [];
      let keys: IDBValidKey[] = [];
      keysRequest.onsuccess = () => {
        keys = keysRequest.result;
        const metadataKeys = keys.filter(
          (key): key is string => typeof key === 'string' && key.startsWith(PROJECT_META_KEY_PREFIX),
        );
        for (const key of metadataKeys) {
          const request = store.get(key);
          request.onsuccess = () => {
            if (request.result) records.push({ key, value: request.result as EncryptedProjectRecord });
          };
        }
      };
      keysRequest.onerror = () => reject(keysRequest.error ?? new Error('Studio project list unavailable'));
      tx.oncomplete = () => resolve({ keys, records });
      tx.onerror = () => reject(tx.error ?? new Error('Studio project list unavailable'));
      tx.onabort = () => reject(tx.error ?? new Error('Studio project list unavailable'));
    });
  } finally {
    database.close();
  }
}

async function writeProjectRecords(
  records: ReadonlyArray<{ key: string; value: EncryptedProjectRecord }>,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(PROJECT_STORE, 'readwrite');
      const store = tx.objectStore(PROJECT_STORE);
      records.forEach(({ key, value }) => {
        store.put(value, key);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Studio project save failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Studio project save failed'));
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
  videoFormat: StudioVideoFormat,
  projectName = DEFAULT_PROJECT_NAME,
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
    JSON.stringify({
      projectName,
      files: metadata,
      audioClips,
      videoClips,
      imageLayers,
      videoFormat,
    } satisfies StudioProjectManifest),
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
  projectName: string;
  files: File[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
  videoFormat: StudioVideoFormat;
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
        clip.track < 8 &&
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
      speed: audioClipSpeed(clip),
      pan: Number.isFinite(clip.pan) ? Math.max(-1, Math.min(1, clip.pan)) : 0,
      trackMuted: clip.trackMuted === true,
      trackSolo: clip.trackSolo === true,
      trackGain: audioTrackMixSettings(clip).gain,
      trackPan: audioTrackMixSettings(clip).pan,
      ...audioClipEqSettings(clip),
      gainEnvelope:
        Array.isArray(clip.gainEnvelope?.points) && clip.gainEnvelope.points.length > 0
          ? { ...audioClipGainEnvelope(clip), points: audioClipGainEnvelopePoints(clip) }
          : audioClipGainEnvelope(clip),
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
      track: clip.track === 'overlay' ? ('overlay' as const) : ('main' as const),
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
      transitionOut:
        clip.track !== 'overlay' && typeof clip.transitionOut === 'number' && Number.isFinite(clip.transitionOut)
          ? Math.max(0, Math.min(2, clip.transitionOut))
          : 0,
      transitionType:
        clip.transitionType === 'wipeleft' || clip.transitionType === 'wiperight'
          ? clip.transitionType
          : ('fade' as StudioVideoTransition),
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
        isStudioImageBlendMode(layer.blend) &&
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
        paintLayer: layer.paintLayer === true,
        positionLocked: layer.positionLocked === true,
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
  const videoFormat: StudioVideoFormat =
    manifest.videoFormat === 'square' || manifest.videoFormat === 'portrait' ? manifest.videoFormat : 'landscape';
  return {
    projectName:
      typeof manifest.projectName === 'string' && manifest.projectName.trim().length > 0
        ? manifest.projectName.trim().slice(0, 100)
        : DEFAULT_PROJECT_NAME,
    files,
    audioClips,
    videoClips,
    imageLayers,
    videoFormat,
  };
}

/** Export a passphrase-encrypted portable project; the passphrase never leaves this device. */
export async function exportStudioProject(
  files: File[],
  audioClips: AudioTimelineClip[],
  videoClips: StudioVideoClip[],
  imageLayers: StudioImageLayer[],
  passphrase: string,
  videoFormat: StudioVideoFormat = 'landscape',
  projectName = DEFAULT_PROJECT_NAME,
): Promise<File> {
  if (passphrase.length < 12) throw new Error('Use a passphrase with at least 12 characters');
  const plaintext = await encodeFiles(
    files,
    audioClips,
    videoClips,
    imageLayers,
    videoFormat,
    normalizeProjectName(projectName),
  );
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
  projectName: string;
  files: File[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
  videoFormat: StudioVideoFormat;
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
  videoFormat: StudioVideoFormat = 'landscape',
  projectId = 'current',
  projectName = DEFAULT_PROJECT_NAME,
): Promise<void> {
  const id = normalizeProjectId(projectId);
  const name = normalizeProjectName(projectName);
  if (id !== 'current') {
    const projects = await listStudioProjects(vaultKey);
    if (!projects.some((project) => project.id === id) && projects.length >= MAX_PROJECTS) {
      throw new Error(`Studio supports up to ${MAX_PROJECTS} local projects`);
    }
  }
  const plaintext = await encodeFiles(files, audioClips, videoClips, imageLayers, videoFormat, name);
  try {
    const savedAt = Date.now();
    const [encrypted, metadata] = await Promise.all([
      encryptVaultItem(vaultKey, projectItemId(id), plaintext),
      encryptProjectMetadata({ id, name, savedAt }, vaultKey),
    ]);
    await writeProjectRecords([
      { key: projectDataKey(id), value: { ...encrypted, savedAt } },
      { key: projectMetadataKey(id), value: metadata },
    ]);
  } finally {
    plaintext.fill(0);
  }
}

async function decodeProjectMetadataRecord(
  vaultKey: Uint8Array,
  id: string,
  record: EncryptedProjectRecord | undefined,
): Promise<ProjectMetadata | null> {
  if (!record || record.item_id !== projectMetadataItemId(id)) return null;
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptVaultItem(vaultKey, record.item_id, record.item_key_wrapped, record.payload);
    const metadata = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<ProjectMetadata>;
    if (
      metadata.id !== id ||
      typeof metadata.name !== 'string' ||
      metadata.name.trim().length === 0 ||
      typeof metadata.savedAt !== 'number' ||
      !Number.isFinite(metadata.savedAt)
    ) {
      return null;
    }
    return { id, name: metadata.name.trim().slice(0, 100), savedAt: metadata.savedAt };
  } catch {
    return null;
  } finally {
    plaintext?.fill(0);
  }
}

async function loadProjectMetadata(vaultKey: Uint8Array, id: string): Promise<ProjectMetadata | null> {
  const record = (await transaction('readonly', (store) => store.get(projectMetadataKey(id)))) as
    | EncryptedProjectRecord
    | undefined;
  return decodeProjectMetadataRecord(vaultKey, id, record);
}

export async function listStudioProjects(vaultKey: Uint8Array): Promise<StudioLocalProjectSummary[]> {
  const { keys, records } = await readProjectMetadataRecords();
  const projects = await Promise.all(
    records.map(async ({ key, value }): Promise<StudioLocalProjectSummary | null> => {
      const id = key.slice(PROJECT_META_KEY_PREFIX.length);
      return decodeProjectMetadataRecord(vaultKey, id, value);
    }),
  );
  const valid = projects.filter((project): project is StudioLocalProjectSummary => project !== null);
  if (keys.includes(CURRENT_PROJECT_KEY) && !valid.some((project) => project.id === 'current')) {
    valid.push({ id: 'current', name: DEFAULT_PROJECT_NAME, savedAt: 0 });
  }
  return valid.sort((left, right) => right.savedAt - left.savedAt).slice(0, MAX_PROJECTS);
}

export async function renameStudioProject(vaultKey: Uint8Array, projectId: string, projectName: string): Promise<void> {
  const id = normalizeProjectId(projectId);
  const name = normalizeProjectName(projectName);
  const dataRecord = (await transaction('readonly', (store) => store.get(projectDataKey(id)))) as
    | EncryptedProjectRecord
    | undefined;
  if (!dataRecord || dataRecord.item_id !== projectItemId(id)) throw new Error('Local project not found');
  const priorMetadata = await loadProjectMetadata(vaultKey, id);
  const savedAt = priorMetadata?.savedAt ?? dataRecord.savedAt;
  const encrypted = await encryptProjectMetadata({ id, name, savedAt }, vaultKey);
  await transaction('readwrite', (store) => store.put(encrypted, projectMetadataKey(id)));
}

export async function deleteStudioProject(projectId: string): Promise<void> {
  const id = normalizeProjectId(projectId);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(PROJECT_STORE, 'readwrite');
      const store = tx.objectStore(PROJECT_STORE);
      store.delete(projectDataKey(id));
      store.delete(projectMetadataKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Studio project delete failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Studio project delete failed'));
    });
  } finally {
    database.close();
  }
}

export async function loadStudioProject(
  vaultKey: Uint8Array,
  projectId = 'current',
): Promise<{
  id: string;
  name: string;
  savedAt: number;
  files: File[];
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  imageLayers: StudioImageLayer[];
  videoFormat: StudioVideoFormat;
}> {
  const id = normalizeProjectId(projectId);
  const record = (await transaction('readonly', (store) => store.get(projectDataKey(id)))) as
    | EncryptedProjectRecord
    | undefined;
  const metadata = await loadProjectMetadata(vaultKey, id);
  if (!record) {
    return {
      id,
      name: metadata?.name ?? DEFAULT_PROJECT_NAME,
      savedAt: metadata?.savedAt ?? 0,
      files: [],
      audioClips: [],
      videoClips: [],
      imageLayers: [],
      videoFormat: 'landscape',
    };
  }
  if (record.item_id !== projectItemId(id)) throw new Error('Invalid encrypted Studio project');
  const plaintext = await decryptVaultItem(vaultKey, record.item_id, record.item_key_wrapped, record.payload);
  try {
    const project = decodeFiles(plaintext);
    return {
      ...project,
      id,
      name: metadata?.name ?? project.projectName,
      savedAt: metadata?.savedAt ?? record.savedAt,
    };
  } finally {
    plaintext.fill(0);
  }
}

/** Keep every device-local project readable when the account rotates its VK. */
export async function rewrapStudioProjectKey(oldVk: Uint8Array, newVk: Uint8Array): Promise<void> {
  const { keys } = await readProjectMetadataRecords();
  const recordKeys = keys.filter(
    (key): key is string =>
      key === CURRENT_PROJECT_KEY ||
      (typeof key === 'string' && (key.startsWith(PROJECT_DATA_KEY_PREFIX) || key.startsWith(PROJECT_META_KEY_PREFIX))),
  );
  const staged: Array<{ key: string; value: EncryptedProjectRecord }> = [];
  for (const key of recordKeys) {
    const record = (await transaction('readonly', (store) => store.get(key))) as EncryptedProjectRecord | undefined;
    if (!record || typeof record.item_id !== 'string' || typeof record.item_key_wrapped !== 'string') continue;
    const item_key_wrapped = await rewrapItemKeyForVaultKey(oldVk, newVk, record.item_id, record.item_key_wrapped);
    staged.push({ key, value: { ...record, item_key_wrapped } });
  }
  // Do not update any project until every item key has been rewrapped. The single
  // readwrite transaction makes the commit atomic if IndexedDB rejects a write.
  await writeProjectRecords(staged);
}
