// Client-side Crowd constants. Kept dependency-free so both the SPA and the
// Pages Functions can share one pinned node version / orchestrator origin.
export const CROWD_ORCHESTRATOR_URL = 'https://crowd.flaxia.app';

/** Pinned `@flaxia/node` version served through the /api/crowd asset proxy. */
export const CROWD_NODE_VERSION = '0.3.5';

export const CROWD_SITE_ID = 'flaxia';

export const CROWD_SITE_CAPABILITIES = ['ai-inference', 'vector-embed', 'nudenet'];

export const CROWD_NODE_MAX_CPU_LOAD = 0.15;

/** Consent-protected browser node configuration accepted by `@flaxia/node`. */
export interface CrowdNodeConfig {
  orchestratorUrl: string;
  siteId: string;
  consent: {
    brandName: string;
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  };
  capabilities: string[];
  maxCpuLoad: number;
}

/** Minimal typed surface of the versioned `@flaxia/node` runtime bundle. */
export interface FlaxiaNodeModule {
  initFlaxiaNode(config: CrowdNodeConfig): void;
}

/**
 * Versioned, cache-busting entry path for the browser node bundle. Bumping
 * {@link CROWD_NODE_VERSION} invalidates the immutable proxy cache.
 */
export function crowdNodeEntry(version: string = CROWD_NODE_VERSION): string {
  return `/api/crowd/v${version}-0/index.js`;
}
