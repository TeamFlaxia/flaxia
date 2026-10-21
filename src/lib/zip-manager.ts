import { executeSwZip, SwZipExecutorHandle } from './sw-zip-executor.js';
import { executeWvfsZip, WvfsZipExecutorHandle } from './wvfs-zip-client.js';
import { executeZip, ZipExecutorHandle } from './zip-executor.js';

export type ZipExecutionMode = 'sw' | 'wvfs' | 'legacy';

export interface UniversalZipExecutorHandle {
  destroy: () => void;
  mode: ZipExecutionMode;
  postId: string;
}

// Global execution manager
let activeHandle: UniversalZipExecutorHandle | null = null;

export async function executeUniversalZip(
  postId: string,
  containerEl: HTMLElement,
  mode: ZipExecutionMode = 'wvfs',
  url?: string,
  versionId?: string,
): Promise<UniversalZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    let handle: ZipExecutorHandle | WvfsZipExecutorHandle | SwZipExecutorHandle;

    if (mode === 'sw') {
      handle = await executeSwZip(postId, containerEl, url, undefined, undefined, versionId);
    } else if (mode === 'wvfs') {
      handle = await executeWvfsZip(postId, containerEl, url, false, true, versionId);
    } else {
      handle = await executeZip(postId, containerEl, url, versionId);
    }

    // Create universal handle
    const universalHandle: UniversalZipExecutorHandle = {
      mode,
      postId,
      destroy: () => {
        handle.destroy();
        if (activeHandle?.postId === postId) {
          activeHandle = null;
        }
      },
    };

    activeHandle = universalHandle;
    return universalHandle;
  } catch (error) {
    // Clean up on error
    if (activeHandle) {
      activeHandle.destroy();
      activeHandle = null;
    }
    throw error;
  }
}

// Browser ZIP playback always stays on the isolated sandbox origin.
export function getOptimalZipMode(): ZipExecutionMode {
  return 'wvfs';
}

// Auto-detect and execute with optimal mode
export async function executeZipAuto(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
  versionId?: string,
  mode?: ZipExecutionMode,
): Promise<UniversalZipExecutorHandle> {
  const resolved = mode ?? getOptimalZipMode();
  console.log(`Using ZIP execution mode: ${resolved}`);
  return executeUniversalZip(postId, containerEl, resolved, url, versionId);
}
