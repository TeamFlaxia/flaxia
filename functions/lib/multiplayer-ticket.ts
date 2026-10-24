const TTL_SECONDS = 60;
const PREFIX = 'multiplayer:socket-ticket:';

interface SocketTicket {
  sessionToken: string;
  roomId: string;
  expiresAt: number;
}

/** Short-lived, room-scoped capability; the session cookie never leaves the server. */
export async function createMultiplayerTicket(
  cache: KVNamespace,
  sessionToken: string,
  roomId: string,
): Promise<string> {
  const ticket = crypto.randomUUID();
  const value: SocketTicket = { sessionToken, roomId, expiresAt: Date.now() + TTL_SECONDS * 1000 };
  await cache.put(PREFIX + ticket, JSON.stringify(value), { expirationTtl: TTL_SECONDS });
  return ticket;
}

export async function resolveMultiplayerTicket(
  cache: KVNamespace,
  ticket: string,
  roomId: string,
): Promise<string | null> {
  if (!/^[a-f0-9-]{36}$/.test(ticket)) return null;
  const value = await cache.get<SocketTicket>(PREFIX + ticket, 'json');
  if (!value || value.roomId !== roomId || value.expiresAt <= Date.now()) return null;
  // The caller revalidates the session and current room membership on every upgrade.
  return value.sessionToken;
}
