import { API_ORIGIN, isTauriNativePlatform } from './native-api.ts';

// Shared by the SPA, native build preparation, and Pages Functions.
export const CROWD_ORCHESTRATOR_URL = 'https://crowd.flaxia.app';

/** Pinned `@flaxia/node` version served through the /api/crowd asset proxy. */
export const CROWD_NODE_VERSION = '0.6.1';

export const CROWD_SITE_ID = 'flaxia';

export const CROWD_SITE_CAPABILITIES = ['ai-inference', 'vector-embed', 'nudenet'];

export const CROWD_NODE_MAX_CPU_LOAD = 0.15;

export type CrowdConsentState = 'unset' | 'granted' | 'denied';

/** Local `ai-inference` payload (host-side shape, same as coordinator tasks). */
export interface LocalAiInferencePayload {
  task: string;
  model: string;
  input: string | string[];
  options?: {
    src_lang?: string;
    tgt_lang?: string;
    ondeviceOnly?: boolean;
    [key: string]: unknown;
  };
}

export interface OndeviceUnavailableError extends Error {
  code?: string;
  status?: number;
  detail?: string;
}

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
  /**
   * Light Inference: run `ai-inference` locally without involving the
   * orchestrator. Present on 0.6.0+ bundles; older bundles leave it undefined
   * and callers must fall back to a coordinator routed task.
   */
  runLocalAiInference?: (payload: LocalAiInferencePayload) => Promise<{ output: unknown }>;
  isAiModelPreloaded?: (model: string) => boolean;
  preloadAiModel?: (request: { task: string; model: string; dtype?: string; device?: string }) => Promise<void>;
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
  /** Exact HTTPS origins allowed to serve executable container WASM images. */
  containerImageOrigins?: string[];
  /** Exact same-origin API host allowed to serve signed scan-file tickets. */
  fileSourceOrigins?: string[];
  /** Exact origins allowed to serve signed Common Crawl byte ranges. */
  ccRangeOrigins?: string[];
  maxCpuLoad?: number;
}

/** Minimal typed surface of the versioned `@flaxia/node` runtime bundle. */
export interface FlaxiaNodeModule {
  initFlaxiaNode(config: CrowdNodeConfig): CrowdNodeController;
  /** Persisted consent state, available without initialising the node. */
  getFlaxiaNodeConsentState(): CrowdConsentState;
  /** Verify the persisted consent record before reading it (required by v0.5.0). */
  initFlaxiaNodeConsent(): Promise<CrowdConsentState>;
  /** Allow the app's own explicit consent UI to grant consent. */
  setFlaxiaNodeHostManagedConsent(allowed: boolean): void;
}

/**
 * Versioned, cache-busting entry path for the browser node bundle. Bumping
 * {@link CROWD_NODE_VERSION} invalidates the immutable proxy cache.
 */
export function crowdNodeEntry(version: string = CROWD_NODE_VERSION): string {
  const root = isTauriNativePlatform() ? '/native-crowd' : '/api/crowd';
  return `${root}/v${version}-0/index.js`;
}

let modulePromise: Promise<FlaxiaNodeModule> | null = null;
let moduleRef: FlaxiaNodeModule | null = null;
let controller: CrowdNodeController | null = null;

/**
 * Load the pinned node bundle once and reuse it. The same module instance owns
 * the node lifecycle, so callers must go through {@link initCrowdNode} rather
 * than importing the bundle again.
 */
export function loadCrowdNodeModule(version: string = CROWD_NODE_VERSION): Promise<FlaxiaNodeModule> {
  if (!modulePromise) {
    modulePromise = (import(/* @vite-ignore */ crowdNodeEntry(version)) as Promise<FlaxiaNodeModule>).then(
      async (mod) => {
        moduleRef = mod;
        // v0.5.0 fails closed until the persisted HMAC-backed record is verified.
        // Await that before initFlaxiaNode reads the state, or every fresh page load
        // appears to have no consent and opens the prompt again.
        await mod.initFlaxiaNodeConsent();
        // Flaxia renders the disclosure itself. The Crowd bundle otherwise rejects
        // controller.grant()/controls.accept() because it cannot verify a built-in
        // banner click.
        mod.setFlaxiaNodeHostManagedConsent(true);
        return mod;
      },
    );
  }
  return modulePromise;
}

/**
 * Whether this device may run a Crowd node at all. Kept here (rather than in
 * `main.ts`) so the settings screen reflects the same decision.
 *
 * This is intentionally permissive: `@flaxia/node` probes the real amount of
 * WebAssembly memory it can commit before advertising heavy capabilities, so we
 * must not refuse capable devices just because a browser doesn't expose
 * `navigator.deviceMemory` (Firefox, Safari, WebKit-based desktop shells) or
 * reports an odd core count.
 */
export function canRunFlaxiaNode(): boolean {
  if (typeof navigator === 'undefined') return false;

  // The only hard block: native Capacitor WebViews. Loading multi-GB WASM
  // models there can spike memory and Android/iOS may kill the whole app
  // process, which is far worse than simply not contributing.
  const isCapacitorNative =
    typeof window !== 'undefined' &&
    typeof window.Capacitor !== 'undefined' &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();
  if (isCapacitorNative) return false;

  // Reject only devices that explicitly report a very small amount of memory.
  // Unknown values are allowed through; the node re-checks with a real probe.
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === 'number' && deviceMemory < 2) return false;

  // Same for cores: an unknown count is not a reason to refuse, only an
  // explicitly single-core device is.
  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0 && cores < 2) return false;

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
    fileSourceOrigins:
      typeof window !== 'undefined' ? [isTauriNativePlatform() ? API_ORIGIN : window.location.origin] : [],
    ccRangeOrigins:
      typeof window !== 'undefined' ? [isTauriNativePlatform() ? API_ORIGIN : window.location.origin] : [],
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

/** Persisted consent state. Uses the node bundle's API once it is loaded. */
export function getCrowdConsentState(): CrowdConsentState {
  if (controller) return controller.getConsentState();
  if (moduleRef && typeof moduleRef.getFlaxiaNodeConsentState === 'function') {
    return moduleRef.getFlaxiaNodeConsentState();
  }
  return 'unset';
}

/**
 * Ensure the node bundle is loaded, then return the persisted consent state.
 * Lets the settings screen render the correct value before `initCrowdNode`
 * (deferred app init) has created a controller.
 */
export async function resolveCrowdConsentState(): Promise<CrowdConsentState> {
  try {
    await loadCrowdNodeModule();
  } catch {
    // Offline or proxy error: fall back to whatever we already know.
  }
  return getCrowdConsentState();
}

/** Fired on `window` whenever consent is granted/denied so open UIs can refresh. */
export const CROWD_CONSENT_CHANGE_EVENT = 'crowdconsentchange';

/** Notify listeners (e.g. the settings screen) that consent state changed. */
export function notifyCrowdConsentChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CROWD_CONSENT_CHANGE_EVENT));
}

export function grantCrowdConsent(): void {
  controller?.grant();
  notifyCrowdConsentChanged();
}

export function denyCrowdConsent(): void {
  controller?.deny();
  notifyCrowdConsentChanged();
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

/**
 * Whether the attached node can serve a translate model instantly from this
 * device (Light Inference warm check). Returns false on old bundles.
 */
export function isLocalTranslateReady(model: string): boolean {
  if (!controller?.isRunning?.()) return false;
  if (getCrowdConsentState() !== 'granted') return false;
  return controller.isAiModelPreloaded?.(model) ?? false;
}

/** True when the attached node exposes the Light Inference local-run API. */
export function hasLightInference(): boolean {
  return typeof controller?.runLocalAiInference === 'function';
}

/**
 * Run `ai-inference` on this device via Light Inference.
 * With `ondeviceOnly: true` a missing model throws an error with
 * `code === 'ONDEVICE_UNAVAILABLE'` and `status === 500`; nothing is
 * delegated. Callers should treat that as "show download progress".
 */
export async function runLocalAiInference(payload: LocalAiInferencePayload): Promise<{ output: unknown }> {
  const run = controller?.runLocalAiInference;
  if (!run || !controller?.isRunning?.()) {
    const err = new Error('On-device model not available') as OndeviceUnavailableError & { name: string };
    err.name = 'OndeviceUnavailableError';
    err.code = 'ONDEVICE_UNAVAILABLE';
    err.status = 500;
    err.detail = 'node_not_running';
    throw err;
  }
  if (getCrowdConsentState() !== 'granted') {
    const err = new Error('On-device model not available') as OndeviceUnavailableError & { name: string };
    err.name = 'OndeviceUnavailableError';
    err.code = 'ONDEVICE_UNAVAILABLE';
    err.status = 500;
    err.detail = 'consent_not_granted';
    throw err;
  }
  return run.call(controller, payload);
}

/**
 * Download + warm a translate model on this device (Light Inference
 * preload). No-ops when the node cannot run; resolves once the model is
 * ready to serve `ondeviceOnly` tasks. Safe to call while the idle
 * preloader is already warming the same model (idempotent).
 */
export async function preloadLocalAiModel(request: { model: string; task: string; dtype?: string }): Promise<void> {
  const preload = controller?.preloadAiModel;
  if (!preload || !controller?.isRunning?.()) return;
  if (getCrowdConsentState() !== 'granted') return;
  await preload.call(controller, request);
}

export function isOndeviceUnavailable(error: unknown): boolean {
  const rec = error as { code?: unknown; status?: unknown } | null;
  return (
    rec?.code === 'ONDEVICE_UNAVAILABLE' || (rec?.status === 500 && /ondevice/i.test((error as Error)?.message ?? ''))
  );
}
