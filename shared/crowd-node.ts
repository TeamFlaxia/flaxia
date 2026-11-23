/**
 * Pinned `@flaxia/node` version.
 *
 * The SPA, native build preparation, and the Vite build must agree on this
 * value. The browser bundle is copied to `/crowd/v<version>-0/` in the static
 * output (same-origin, immutable) and served from node_modules in dev.
 */
export const CROWD_NODE_VERSION = '0.9.1';
