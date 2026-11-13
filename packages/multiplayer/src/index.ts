/**
 * @flaxia/multiplayer is deprecated.
 *
 * The multiplayer client now lives in `@flaxia/game-sdk`, which bundles it with
 * the rest of the Flaxia Game API. This entry point stays as a compatibility
 * re-export so existing imports keep working.
 *
 * ```ts
 * import { MultiplayerClient } from '@flaxia/game-sdk';
 * ```
 */

export * from '../../game-sdk/src/multiplayer/index.ts';
