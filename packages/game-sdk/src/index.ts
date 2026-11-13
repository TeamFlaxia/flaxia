/**
 * Flaxia Game SDK
 *
 * The sandbox-side SDK for Flaxia games. It wraps the typed postMessage bridge
 * to the main origin and bundles the multiplayer client, so a game only needs:
 *
 * ```html
 * <script src="/sdk/game.js"></script>
 * <script>
 *   const game = new FlaxiaGame.FlaxiaGame({ gameId: 'my-game' });
 * </script>
 * ```
 *
 * See `docs/developer/game-api.md` for the full contract.
 */

export type {
  FlaxiaGameEventMap,
  FlaxiaGameOptions,
  GameTitleDefinition,
  ScoreSubmittedEvent,
  TitleErrorEvent,
} from './flaxia-game.ts';
export { FlaxiaGame } from './flaxia-game.ts';
export type { MultiplayerClientOptions } from './multiplayer/client.ts';
export { MultiplayerClient } from './multiplayer/client.ts';
export type {
  ChatEvent,
  GameOverEvent,
  GameStateEvent,
  MultiplayerError,
  MultiplayerEvents,
  P2PStateEvent,
  PeerDataEvent,
  PlayerInfo,
  PlayerInputEvent,
  RoomInfo,
  RoomState,
  RoomStatus,
} from './multiplayer/types.ts';
export type {
  CaptureFrame,
  EquippedTitle,
  GameTitlePayload,
  GameToParentMessage,
  ParentToGameMessage,
  PlayerIdentity,
} from './protocol.ts';
export {
  DEFAULT_ALLOWED_ORIGINS,
  isGameToParentMessage,
  isParentToGameMessage,
  MAX_CHAT_LENGTH,
  MAX_ID_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_TITLE_DESCRIPTION_LENGTH,
  MAX_TITLE_ICON_LENGTH,
  MAX_TITLE_ID_LENGTH,
  MAX_TITLE_NAME_LENGTH,
} from './protocol.ts';
