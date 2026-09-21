// Client-side Crowd constants. Kept dependency-free so both the SPA and the
// Pages Functions can share one pinned node version / orchestrator origin.
export const CROWD_ORCHESTRATOR_URL = 'https://crowd.flaxia.app';

/** Pinned `@flaxia/node` version served through the /api/crowd asset proxy. */
export const CROWD_NODE_VERSION = '0.3.6';

export const CROWD_SITE_ID = 'flaxia';

export const CROWD_SITE_CAPABILITIES = ['ai-inference', 'vector-embed', 'nudenet'];

export const CROWD_NODE_MAX_CPU_LOAD = 0.15;

export type CrowdConsentState = 'unset' | 'granted' | 'denied';

/** Handed to the host when it renders its own consent UI. */
export interface CrowdConsentControls {
  state: CrowdConsentState;
  accept(): void;
  reject(): void;
}

/**
 * Control surface returned by `initFlaxiaNode`. Flaxia keeps the instance so the
 * settings screen can reflect and change participation without a reload.
 */
export interface CrowdNodeController {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getConsentState(): CrowdConsentState;
  grant(): void;
  deny(): void;
  clearConsent(): void;
}

/** Consent-protected browser node configuration accepted by `@flaxia/node`. */
export interface CrowdNodeConfig {
  orchestratorUrl: string;
  siteId: string;
  consent: {
    brandName: string;
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    accentColor?: string;
    /**
     * When set, `@flaxia/node` skips its built-in banner and asks Flaxia to
     * present its own modal instead.
     */
    onConsentRequired?: (controls: CrowdConsentControls) => void;
  };
  capabilities?: string[];
  maxCpuLoad?: number;
}

/** Minimal typed surface of the versioned `@flaxia/node` runtime bundle. */
export interface FlaxiaNodeModule {
  initFlaxiaNode(config: CrowdNodeConfig): CrowdNodeController;
}

/**
 * Versioned, cache-busting entry path for the browser node bundle. Bumping
 * {@link CROWD_NODE_VERSION} invalidates the immutable proxy cache.
 */
export function crowdNodeEntry(version: string = CROWD_NODE_VERSION): string {
  return `/api/crowd/v${version}-0/index.js`;
}

let modulePromise: Promise<FlaxiaNodeModule> | null = null;
let controller: CrowdNodeController | null = null;

/**
 * Load the pinned node bundle once and reuse it. The same module instance owns
 * the node lifecycle, so callers must go through {@link initCrowdNode} rather
 * than importing the bundle again.
 */
export function loadCrowdNodeModule(version: string = CROWD_NODE_VERSION): Promise<FlaxiaNodeModule> {
  if (!modulePromise) {
    modulePromise = import(/* @vite-ignore */ crowdNodeEntry(version)) as Promise<FlaxiaNodeModule>;
  }
  return modulePromise;
}

/**
 * Whether this device may run a Crowd node at all. Kept here (rather than in
 * `main.ts`) so the settings screen reflects the same decision.
 */
export function canRunFlaxiaNode(): boolean {
  if (typeof navigator === 'undefined') return false;

  // The crowd node runs Web Workers that load heavy WebAssembly inference
  // (transformers.js / onnxruntime). We keep it out of the native Capacitor
  // WebView: a model load there can spike memory and Android/iOS will kill
  // the whole app process.
  //
  // `navigator.deviceMemory` IS reported by Android Chrome (quantized), so
  // Android Chrome passes the numeric check and is allowed to run as a node.
  // @flaxia/node >= 0.3.4 gates heavy WASM behind a real measured probe, so the
  // node re-checks before loading any model. Requiring a KNOWN value >= 4 GB is
  // a conservative safety margin for platforms that don't expose the value.
  const isCapacitorNative =
    typeof window !== 'undefined' &&
    typeof window.Capacitor !== 'undefined' &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();
  if (isCapacitorNative) return false;

  const cores = navigator.hardwareConcurrency ?? 0;
  if (cores < 4) return false;

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory !== 'number' || deviceMemory < 4) return false;
  return true;
}

function buildNodeConfig(onConsentRequired?: (controls: CrowdConsentControls) => void): CrowdNodeConfig {
  return {
    orchestratorUrl: CROWD_ORCHESTRATOR_URL,
    siteId: CROWD_SITE_ID,
    consent: {
      brandName: 'Flaxia',
      position: 'bottom-right',
      onConsentRequired,
    },
    capabilities: CROWD_SITE_CAPABILITIES,
    maxCpuLoad: CROWD_NODE_MAX_CPU_LOAD,
  };
}

/**
 * Initialise the node once and return its controller. `onConsentRequired` is
 * invoked only when the decision is still unset, so callers should pass their
 * consent UI opener. Subsequent calls return the cached controller.
 */
export async function initCrowdNode(
  onConsentRequired?: (controls: CrowdConsentControls) => void,
): Promise<CrowdNodeController | null> {
  if (controller) return controller;
  const { initFlaxiaNode } = await loadCrowdNodeModule();
  const result = initFlaxiaNode(
    // Always pass a handler (`@flaxia/node` would otherwise render its built-in
    // banner) even when the caller has nothing to show.
    buildNodeConfig(onConsentRequired ?? (() => {})),
  );
  // Guard against an older pinned bundle that predates the controller API.
  controller = result && typeof result.getConsentState === 'function' ? result : null;
  return controller;
}

export function getCrowdNodeController(): CrowdNodeController | null {
  return controller;
}

/** Persisted consent state, or `unset` while the node bundle is unavailable. */
export function getCrowdConsentState(): CrowdConsentState {
  return controller?.getConsentState() ?? 'unset';
}

export function grantCrowdConsent(): void {
  controller?.grant();
}

export function denyCrowdConsent(): void {
  controller?.deny();
}

export function startCrowdNode(): void {
  controller?.start();
}

export function stopCrowdNode(): void {
  controller?.stop();
}

export function isCrowdNodeRunning(): boolean {
  return controller?.isRunning() ?? false;
}
