import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getSession, getSessionToken, User } from '../lib/auth';
import { allowedOrigins, authMiddleware, csrfProtection, getBaseOrigin } from './helpers';
import activitypubRouter from './routes/activitypub';
import adminRouter from './routes/admin';
import adsRouter from './routes/ads';
import authRouter from './routes/auth';
import topicRouter from './routes/current-topic';
import gamesRouter from './routes/games';
import linkPreviewRouter from './routes/link-preview';
import meRouter from './routes/me';
import mediaRouter from './routes/media';
import multiplayerRouter from './routes/multiplayer';
import pollsRouter from './routes/polls';
import postVersionsRouter from './routes/post-versions';
import postsRouter from './routes/posts';
import pushRouter from './routes/push';
import reportRouter from './routes/report';
import stampsRouter from './routes/stamps';
import tagsRouter from './routes/tags';
import testsRouter from './routes/tests';
import usersRouter from './routes/users';
import vaultRouter from './routes/vault';

type Bindings = {
  DB: D1Database;
  DB_TEST: D1Database;
  BUCKET: R2Bucket;
  CACHE: KVNamespace;
  SANDBOX_ORIGIN: string;
  BASE_URL: string;
  ADMIN_USERNAMES: string;
  AP_DELIVERY_QUEUE: Queue;
  CROWD_ORCHESTRATOR_URL: string;
  CROWD_API_KEY: string;
  /** Optional dedicated secret for signing callbacks and scan-file tickets. */
  CROWD_WEBHOOK_SECRET?: string;
  CROWD_NODE_ORIGINS: string;
  CROWD_SCAN_FILE_SOURCES: string;
  FILE_SCAN_CLAMAV_IMAGE?: string;
  FILE_SCAN_VIDEO_PHASH_IMAGE?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  CF_ACCESS_AUD: string;
  CF_TEAM_DOMAIN: string;
  CROWD_ORCHESTRATOR?: Fetcher;
  NOTIFICATION_STREAM?: DurableObjectNamespace;
  MULTIPLAYER_ROOM?: DurableObjectNamespace;
  MATCHMAKER?: DurableObjectNamespace;
  FCM_SERVER_KEY?: string;
  VECTORIZE?: Vectorize;
};

type Variables = {
  user: User | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('/api/*', authMiddleware);

app.use(
  '/*',
  cors({
    origin: (origin, c) => {
      if (!origin) return '';
      return allowedOrigins.has(origin) || origin === getBaseOrigin(c) ? origin : '';
    },
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

app.use('/*', csrfProtection);

// Auth routes (extracted to routes/auth.ts)
app.route('/api/auth', authRouter);

// ActivityPub routes (extracted to routes/activitypub.ts)
app.route('/', activitypubRouter);

// Admin routes (extracted to routes/admin.ts)
app.route('/api/admin', adminRouter);

// Media routes (extracted to routes/media.ts)
app.route('/api', mediaRouter);

// User routes (extracted to routes/users.ts)
app.route('/api', usersRouter);

// Poll routes (extracted to routes/polls.ts)
app.route('/api', pollsRouter);

// Stamp routes (extracted to routes/stamps.ts)
app.route('/api', stampsRouter);

// Tag routes (extracted to routes/tags.ts)
app.route('/api', tagsRouter);

// Link-preview routes (extracted to routes/link-preview.ts)
app.route('/api', linkPreviewRouter);

// Current-topic route (extracted to routes/current-topic.ts)
app.route('/api', topicRouter);

// Report route (extracted to routes/report.ts)
app.route('/api', reportRouter);

// Auth/me routes (extracted to routes/me.ts)
app.route('/api', meRouter);

// Ad routes (extracted to routes/ads.ts)
app.route('/api', adsRouter);

// Multiplayer routes (extracted to routes/multiplayer.ts)
app.route('/api/multiplayer', multiplayerRouter);

// Push routes (extracted to routes/push.ts)
app.route('/api', pushRouter);

// Game routes (extracted to routes/games.ts)
app.route('/api', gamesRouter);

// Post routes (extracted to routes/posts.ts)
app.route('/api', postsRouter);

// Game version routes (extracted to routes/post-versions.ts)
app.route('/api', postVersionsRouter);

// Test routes (extracted to routes/tests.ts)
app.route('/', testsRouter);

// Vault key storage (extracted to routes/vault.ts) — see docs/e2ee.md
app.route('/api', vaultRouter);

export async function onRequest(context: Record<string, unknown>) {
  const request = context.request as Request;
  const env = context.env as Bindings;

  // WebSocket 通知ストリーム — デスクトップアプリからの接続を受け付ける
  const url = new URL(request.url);
  if (url.pathname === '/api/ws/notifications' && request.headers.get('Upgrade') === 'websocket') {
    const sessionToken = getSessionToken(request) || url.searchParams.get('token');
    if (!sessionToken) return new Response('Unauthorized', { status: 401 });
    const session = await getSession(env, sessionToken);
    if (!session) return new Response('Unauthorized', { status: 401 });

    if (!env.NOTIFICATION_STREAM) return new Response('Notifications not available', { status: 503 });
    const doId = env.NOTIFICATION_STREAM.idFromName(session.user.id);
    const stub = env.NOTIFICATION_STREAM.get(doId);
    return stub.fetch(request);
  }

  // WebSocket マルチプレイヤールーム
  if (url.pathname === '/api/ws/multiplayer' && request.headers.get('Upgrade') === 'websocket') {
    const roomId = url.searchParams.get('roomId');
    const gameId = url.searchParams.get('gameId');
    if (!roomId || !gameId) return new Response('Missing roomId or gameId', { status: 400 });

    const sessionToken = getSessionToken(request) || url.searchParams.get('token');
    if (!sessionToken) return new Response('Unauthorized', { status: 401 });
    const session = await getSession(env, sessionToken);
    if (!session) return new Response('Unauthorized', { status: 401 });

    // The room must exist: otherwise any UUID opens a phantom DO namespace.
    const room = (await env.DB.prepare('SELECT max_players, host_id FROM multiplayer_rooms WHERE id = ?')
      .bind(roomId)
      .first()) as { max_players?: number; host_id?: string } | null;
    if (!room) return new Response('Room not found', { status: 404 });

    // Only members may open a socket: the DO trusts forwarded identity, so
    // the REST join/leave path is the single gate for membership.
    const member =
      room.host_id === session.user.id
        ? { ok: true }
        : await env.DB.prepare(
            'SELECT 1 FROM multiplayer_room_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
          )
            .bind(roomId, session.user.id)
            .first();
    if (!member) return new Response('Forbidden', { status: 403 });

    const forwardUrl = new URL(request.url);
    forwardUrl.searchParams.set('userId', session.user.id);
    forwardUrl.searchParams.set('username', session.user.username || '');
    forwardUrl.searchParams.set('display_name', session.user.display_name || '');
    forwardUrl.searchParams.set('avatar_key', session.user.avatar_key || '');
    forwardUrl.searchParams.set('gameId', gameId);
    forwardUrl.searchParams.set('roomId', roomId);
    forwardUrl.searchParams.delete('token');
    // Capacity and host come from D1, never from client query params: the
    // DO trusts these values for room sizing and host authority.
    forwardUrl.searchParams.set('maxPlayers', String(room.max_players ?? 2));
    if (room.host_id) forwardUrl.searchParams.set('hostId', room.host_id);

    const forwardReq = new Request(forwardUrl.toString(), {
      headers: request.headers,
    });

    if (!env.MULTIPLAYER_ROOM) return new Response('Multiplayer not available', { status: 503 });
    const doId = env.MULTIPLAYER_ROOM.idFromName(roomId);
    const stub = env.MULTIPLAYER_ROOM.get(doId);
    return stub.fetch(forwardReq);
  }

  return app.fetch(request, env as unknown as Record<string, unknown>, context as unknown as ExecutionContext);
}
