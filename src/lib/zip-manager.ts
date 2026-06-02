import { executeWvfsZip, WvfsZipExecutorHandle } from './wvfs-zip-client.js';
import { executeZip, ZipExecutorHandle } from './zip-executor.js';

export type ZipExecutionMode = 'legacy' | 'wvfs';

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
): Promise<UniversalZipExecutorHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    let handle: ZipExecutorHandle | WvfsZipExecutorHandle;

    if (mode === 'wvfs') {
      handle = await executeWvfsZip(postId, containerEl, url);
    } else {
      handle = await executeZip(postId, containerEl, url);
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

// Helper function to detect best mode based on environment
export function getOptimalZipMode(): ZipExecutionMode {
  // Check if running in Cloudflare Workers environment
  if (typeof globalThis !== 'undefined' && (globalThis as { WebSocketPair?: unknown }).WebSocketPair && (globalThis as { D1Database?: unknown }).D1Database) {
    return 'wvfs';
  }

  // Check if browser supports required features for WVFS
  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
    return 'wvfs';
  }

  // Fallback to legacy mode
  return 'legacy';
}

// Auto-detect and execute with optimal mode
export async function executeZipAuto(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
): Promise<UniversalZipExecutorHandle> {
  const mode = getOptimalZipMode();
  console.log(`Using ZIP execution mode: ${mode}`);
  return executeUniversalZip(postId, containerEl, mode, url);
}
