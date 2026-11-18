/**
 * App-side boundary for `flaxia-render`.
 *
 * The implementation lives in `packages/flaxia-render/src` so it can be built, tested
 * and published on its own. Flaxia imports through this file to keep the
 * dependency boundary explicit.
 *
 * When the package is published (or installed from a separate repository),
 * replace the re-export below with:
 *
 *   export * from 'flaxia-render';
 */
export * from '../../../packages/flaxia-render/src/index.ts';
