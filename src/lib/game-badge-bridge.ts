import { getMe } from './auth-cache.js';
import {
  isParentMessage,
  isSandboxMessage,
  type ParentMessage,
  type PlayerIdentity,
  type SandboxMessage,
} from './bridge.js';

/**
 * Game API relays that need to know *which* post a frame came from.
 *
 * A game runs in an opaque-origin iframe and can only talk by `postMessage`,
 * so it can never name a post itself. Every sandboxed game frame registers
 * here with the post it is executing, and the parent resolves the post by
 * comparing `event.source` with the registered element's `contentWindow` — a
 * window a game cannot forge. That binding is what lets a game award itself
 * achievements only from its own scope.
 */

/** Element identity, not the window: `contentWindow` is null until attached. */
const frames = new Map<HTMLIFrameElement, string>();

/** Identity answers are cached briefly so a game cannot hammer `/api/titles/me`. */
const IDENTITY_TTL_MS = 5_000;
let identityCache: { at: number; value: PlayerIdentity } | null = null;

const SIGNED_OUT: PlayerIdentity = {
  userId: null,
  username: null,
  displayName: null,
  avatarKey: null,
  equippedTitle: null,
};

type TitleFrame = Extract<ParentMessage, { type: 'CREATE_TITLE' | 'AWARD_TITLE' }>;

function postIdFor(source: MessageEventSource | null): string | null {
  if (!source) return null;
  for (const [frame, postId] of frames) {
    if (frame.isConnected && frame.contentWindow === source) return postId;
  }
  return null;
}

function handleMessage(event: MessageEvent): void {
  // Sandboxed frames (no `allow-same-origin`) report an opaque origin, and
  // `event.source` is the only identity the game cannot spoof.
  if (event.origin !== 'null') return;
  const postId = postIdFor(event.source);
  if (!postId) return;

  const data: unknown = event.data;
  if (!isParentMessage(data)) return;

  switch (data.type) {
    case 'REQUEST_IDENTITY':
      void replyIdentity(event);
      break;
    case 'CREATE_TITLE':
      void replyTitle(event, 'create', postId, data);
      break;
    case 'AWARD_TITLE':
      void replyTitle(event, 'award', postId, data);
      break;
    default:
      break;
  }
}

function postToGame(event: MessageEvent, message: SandboxMessage): void {
  if (!isSandboxMessage(message)) return;
  try {
    (event.source as Window | null)?.postMessage(message, '*');
  } catch {
    // The frame went away mid-request; a dropped reply is not fatal.
  }
}

async function resolveIdentity(): Promise<PlayerIdentity> {
  const cached = identityCache;
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.value;

  let identity = SIGNED_OUT;
  try {
    const me = (await getMe()) as { user?: Record<string, unknown> } | null;
    const user = me?.user;
    if (user && typeof user.id === 'string') {
      identity = {
        userId: user.id,
        username: typeof user.username === 'string' ? user.username : null,
        displayName: typeof user.display_name === 'string' ? user.display_name : null,
        avatarKey: typeof user.avatar_key === 'string' ? user.avatar_key : null,
        equippedTitle: await resolveEquippedTitle(),
      };
    }
  } catch {
    identity = SIGNED_OUT;
  }

  identityCache = { at: Date.now(), value: identity };
  return identity;
}

async function resolveEquippedTitle(): Promise<PlayerIdentity['equippedTitle']> {
  try {
    const res = await fetch('/api/titles/me', { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      titles?: Array<{
        id: string;
        name: string;
        name_ja: string;
        description: string;
        description_ja: string;
        icon: string;
      }>;
      equipped_title_id?: string | null;
    };
    const equippedId = data.equipped_title_id;
    if (!equippedId) return null;
    const title = data.titles?.find((candidate) => candidate.id === equippedId);
    if (!title) return null;
    return {
      id: title.id,
      name: title.name,
      nameJa: title.name_ja,
      description: title.description,
      descriptionJa: title.description_ja,
      icon: title.icon,
    };
  } catch {
    return null;
  }
}

async function replyIdentity(event: MessageEvent): Promise<void> {
  postToGame(event, { type: 'PLAYER_IDENTITY', identity: await resolveIdentity() });
}

/** Maps a failed relay onto a stable `TITLE_ERROR` code for the game. */
function titleErrorCode(status: number, serverCode?: string): string {
  if (serverCode) return serverCode.slice(0, 64);
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 404) return 'POST_NOT_FOUND';
  if (status === 409) return 'TITLE_CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400) return 'INVALID_TITLE';
  return 'INTERNAL';
}

async function replyTitle(
  event: MessageEvent,
  action: 'create' | 'award',
  postId: string,
  frame: TitleFrame,
): Promise<void> {
  const fail = (status: number, message: string, code?: string): void => {
    postToGame(event, {
      type: 'TITLE_ERROR',
      code: titleErrorCode(status, code),
      message: message.slice(0, 500),
      titleId: frame.titleId,
    });
  };

  try {
    const res = await fetch(action === 'create' ? '/api/titles/game' : '/api/titles/game/award', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        postId,
        titleId: frame.titleId,
        name: frame.name,
        ...(frame.nameJa !== undefined && { nameJa: frame.nameJa }),
        ...(frame.description !== undefined && { description: frame.description }),
        ...(frame.descriptionJa !== undefined && { descriptionJa: frame.descriptionJa }),
        ...(frame.icon !== undefined && { icon: frame.icon }),
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      fail(res.status, body.error ?? 'Title request failed', body.code);
      return;
    }

    postToGame(event, {
      type: action === 'create' ? 'TITLE_CREATED' : 'TITLE_AWARDED',
      titleId: frame.titleId,
    });
  } catch {
    fail(0, 'Title request failed', 'NETWORK');
  }
}

let installed = false;

/**
 * Bind a sandboxed game frame to the post it is executing. Returns an
 * unbind that must run when the frame is destroyed.
 */
export function registerGameFrame(frame: HTMLIFrameElement, postId: string): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!installed) {
    window.addEventListener('message', handleMessage);
    installed = true;
  }
  frames.set(frame, postId);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    frames.delete(frame);
    if (frames.size === 0) identityCache = null;
  };
}
