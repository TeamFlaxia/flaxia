import { MultiplayerClient } from './multiplayer/client.ts';
import {
  DEFAULT_ALLOWED_ORIGINS,
  type GameToParentMessage,
  isGameToParentMessage,
  isParentToGameMessage,
  type ParentToGameMessage,
  type PlayerIdentity,
} from './protocol.ts';

export interface FlaxiaGameOptions {
  /** Stable game identifier. Required — the parent uses it to create/join a room. */
  gameId: string;
  /** Join an existing room instead of creating a new one. */
  roomId?: string;
  /** Connect multiplayer as soon as the client is created (default: true). */
  autoConnect?: boolean;
  /**
   * Parent origins allowed to exchange frames with this game. Defaults to the
   * Flaxia main origin; pass localhost origins when developing locally.
   */
  allowedOrigins?: string[];
}

export interface ScoreSubmittedEvent {
  score: number;
  label: string;
}

/**
 * An achievement a game authors for itself. `id` only has to be unique within
 * the game — namespace it (for example `<gameId>.level1`) so it can never
 * collide with another game's badge or a platform title.
 */
export interface GameTitleDefinition {
  id: string;
  name: string;
  nameJa?: string;
  description?: string;
  descriptionJa?: string;
  /** Same-origin image path only (for example `/icons/badge-96.png`). */
  icon?: string;
}

/** The parent rejected a `createTitle()` or `awardTitle()` frame. */
export interface TitleErrorEvent {
  code: string;
  message: string;
  titleId?: string;
}

/** Platform events emitted by {@link FlaxiaGame}. */
export interface FlaxiaGameEventMap {
  /** The parent answered a `requestFullscreen()` call. */
  fullscreen: (granted: boolean) => void;
  /** The parent answered a `requestFresh()` call. */
  fresh: (granted: boolean) => void;
  /** The parent acknowledged a score submitted with `submitScore()`. */
  scoreSubmitted: (event: ScoreSubmittedEvent) => void;
  /** The parent answered a `requestIdentity()` call. */
  identity: (identity: PlayerIdentity) => void;
  /** The parent stored a definition sent with `createTitle()`. */
  titleCreated: (event: { titleId: string }) => void;
  /** The parent granted a title sent with `awardTitle()` to the player. */
  titleAwarded: (event: { titleId: string }) => void;
  /** The parent rejected a title frame. */
  titleError: (event: TitleErrorEvent) => void;
  /** Every validated frame received from the parent. */
  message: (message: ParentToGameMessage) => void;
}

/**
 * Flaxia Game API entry point.
 *
 * A thin, typed wrapper around the sandbox bridge: it owns the `postMessage`
 * transport, exposes the platform capabilities (fullscreen, fresh, score) and
 * bundles {@link MultiplayerClient} so a game needs a single script tag.
 *
 * The game never talks to the network directly — the parent relays everything.
 */
export class FlaxiaGame {
  readonly gameId: string;
  readonly multiplayer: MultiplayerClient;

  private allowedOrigins: string[];
  private targetOrigin: string;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private handlers: { [K in keyof FlaxiaGameEventMap]?: FlaxiaGameEventMap[K] } = {};

  constructor(options: FlaxiaGameOptions) {
    if (typeof options.gameId !== 'string' || options.gameId.length === 0) {
      throw new Error('FlaxiaGame: gameId is required');
    }

    this.gameId = options.gameId;
    this.allowedOrigins = options.allowedOrigins ?? [...DEFAULT_ALLOWED_ORIGINS];
    this.targetOrigin = this.allowedOrigins[0];

    this.multiplayer = new MultiplayerClient({
      gameId: options.gameId,
      roomId: options.roomId,
      autoConnect: options.autoConnect,
      allowedOrigins: this.allowedOrigins,
    });

    this.messageHandler = (event: MessageEvent) => this.handleMessage(event);
    window.addEventListener('message', this.messageHandler);
  }

  /** Ask the parent to enter fullscreen. Listen with `on('fullscreen', ...)`. */
  requestFullscreen(): void {
    this.postToParent({ type: 'REQUEST_FULLSCREEN' });
  }

  /** Ask the parent to fresh (like) the post this game belongs to. */
  requestFresh(): void {
    this.postToParent({ type: 'REQUEST_FRESH' });
  }

  /**
   * Ask who is playing. The parent answers with an `identity` event; every
   * field of the identity is `null` while nobody is signed in.
   */
  requestIdentity(): void {
    this.postToParent({ type: 'REQUEST_IDENTITY' });
  }

  /**
   * Register a title definition with the game the player is running. Use this
   * to publish an achievement list before any of it is earned. Definitions are
   * write-once: the first version the platform sees wins.
   */
  createTitle(definition: GameTitleDefinition): void {
    const frame = toTitleFrame('CREATE_TITLE', definition);
    if (frame) this.postToParent(frame);
  }

  /**
   * Create the title if needed and grant it to the signed-in player. Only
   * titles scoped to this game can be granted — the platform rejects a frame
   * that names another game's badge or a platform title.
   */
  awardTitle(definition: GameTitleDefinition): void {
    const frame = toTitleFrame('AWARD_TITLE', definition);
    if (frame) this.postToParent(frame);
  }

  /**
   * Submit a score. The parent shows a toast and acknowledges with a
   * `scoreSubmitted` event; the platform records it on the leaderboard.
   */
  submitScore(score: number, label = ''): void {
    if (typeof score !== 'number' || !Number.isFinite(score)) return;
    this.postToParent({ type: 'POST_SCORE', score, label: typeof label === 'string' ? label : '' });
  }

  /**
   * Send an arbitrary validated Game API frame. Prefer the typed helpers for
   * the common capabilities; this is the escape hatch for newer frames.
   */
  sendMessage(message: GameToParentMessage): void {
    if (!isGameToParentMessage(message)) return;
    this.postToParent(message);
  }

  /** Register a platform event handler. */
  on<K extends keyof FlaxiaGameEventMap>(event: K, handler: FlaxiaGameEventMap[K]): void {
    this.handlers[event] = handler;
  }

  /** Stop listening and disconnect multiplayer. Safe to call more than once. */
  destroy(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.multiplayer.disconnect();
    this.handlers = {};
  }

  get isConnected(): boolean {
    return this.multiplayer.isConnected;
  }

  get currentRoomId(): string | null {
    return this.multiplayer.currentRoomId;
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.isOriginAllowed(event.origin)) return;
    if (!isParentToGameMessage(event.data)) return;

    const message = event.data;
    const onMessage = this.handlers.message;
    if (onMessage) onMessage(message);

    switch (message.type) {
      case 'FULLSCREEN_GRANTED':
        this.handlers.fullscreen?.(true);
        break;
      case 'FULLSCREEN_DENIED':
        this.handlers.fullscreen?.(false);
        break;
      case 'FRESH_GRANTED':
        this.handlers.fresh?.(true);
        break;
      case 'FRESH_DENIED':
        this.handlers.fresh?.(false);
        break;
      case 'SCORE_SUBMITTED':
        this.handlers.scoreSubmitted?.({ score: message.score, label: message.label });
        break;
      case 'PLAYER_IDENTITY':
        this.handlers.identity?.(message.identity);
        break;
      case 'TITLE_CREATED':
        this.handlers.titleCreated?.({ titleId: message.titleId });
        break;
      case 'TITLE_AWARDED':
        this.handlers.titleAwarded?.({ titleId: message.titleId });
        break;
      case 'TITLE_ERROR':
        this.handlers.titleError?.({
          code: message.code,
          message: message.message,
          titleId: message.titleId,
        });
        break;
      default:
        break;
    }
  }

  private isOriginAllowed(origin: string): boolean {
    return this.allowedOrigins.some((allowed) => {
      if (allowed.includes('*')) {
        const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
        return new RegExp(`^${escaped}$`).test(origin);
      }
      return origin === allowed;
    });
  }

  private postToParent(message: GameToParentMessage): void {
    try {
      window.parent.postMessage(message, this.targetOrigin);
    } catch {
      // The parent may be navigating away; a dropped frame is not fatal.
    }
  }
}

/**
 * Normalizes a definition into a wire frame. The runtime guard is the single
 * place that enforces every length cap, so an oversized definition is dropped
 * locally instead of being rejected by the parent with no feedback.
 */
function toTitleFrame(
  type: 'CREATE_TITLE' | 'AWARD_TITLE',
  definition: GameTitleDefinition,
): GameToParentMessage | null {
  if (!definition || typeof definition !== 'object') return null;

  const frame: Record<string, unknown> = { type, titleId: definition.id, name: definition.name };
  if (definition.nameJa !== undefined) frame.nameJa = definition.nameJa;
  if (definition.description !== undefined) frame.description = definition.description;
  if (definition.descriptionJa !== undefined) frame.descriptionJa = definition.descriptionJa;
  if (definition.icon !== undefined) frame.icon = definition.icon;

  return isGameToParentMessage(frame) ? frame : null;
}
