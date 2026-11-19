/**
 * Pinned `@flaxia/node` version served through the /api/crowd asset proxy.
 *
 * The SPA, native build preparation, and Pages Functions must agree on this
 * value: the proxy caches by version, so a mismatch between the client URL and
 * the server allowlist would 404 assets.
 */
export const CROWD_NODE_VERSION = '0.9.0';
