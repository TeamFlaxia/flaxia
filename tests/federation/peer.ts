// Peers for the federation test.
//
// A peer is another ActivityPub implementation that runs next to the instance
// under test. The tests only use the parts of the Mastodon compatible API
// that every implementation offers, so the same scenarios run against
// GoToSocial and against Mastodon.
import { spawnSync } from 'node:child_process';

export interface PeerAccount {
  id: string;
  username: string;
  actorUrl: string;
  inboxUrl: string;
}

export interface PeerStatus {
  id: string;
  content: string;
  url: string;
}

export interface FederationPeer {
  readonly name: string;
  readonly origin: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The account the peer federates with. */
  account(): Promise<PeerAccount>;
  /** Post a note and return it. */
  post(text: string): Promise<PeerStatus>;
  /** The statuses the peer received (home timeline). */
  timeline(): Promise<PeerStatus[]>;
  /** Follow an account by its id. */
  follow(accountId: string): Promise<void>;
  /** The actors that follow the peer account. */
  followers(): Promise<string[]>;
  /** The accounts the peer account follows. */
  following(): Promise<string[]>;
  /** Look an account up by its handle. */
  lookup(handle: string): Promise<PeerAccount | null>;
  /** The activities the peer received, read from its timeline. */
  actorDocument(): Promise<Record<string, unknown>>;
}

function docker(args: string[], options: { capture?: boolean } = {}): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout || 'no output'}`,
    );
  }
  return options.capture ? (result.stdout ?? '').trim() : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(500);
  }
  throw new Error(`The peer did not become ready: ${lastError}`);
}

/** Extract the first form of an HTML document. */
function parseForm(html: string): { action: string; fields: Record<string, string> } | null {
  const formMatch = html.match(/<form\b[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const fields: Record<string, string> = {};
  for (const input of formMatch[2].matchAll(/<input\b[^>]*>/gi)) {
    const name = input[0].match(/name="([^"]*)"/i)?.[1];
    if (!name) continue;
    const value = input[0].match(/value="([^"]*)"/i)?.[1] ?? '';
    fields[name] = value;
  }
  return { action: formMatch[1], fields };
}

/** The cookies of a session. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (!pair || index < 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/**
 * Log in with a user name and a password and return an access token.
 *
 * The OAuth flow of the Mastodon compatible API needs an application and an
 * authorization. The authorization starts with the sign in page of the
 * instance, which answers with the session that carries the request over to
 * the consent page.
 */
export async function loginWithPassword(origin: string, username: string, password: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:9999/oauth/callback';
  const scope = 'read write follow';

  const appResponse = await fetch(`${origin}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'flaxia-federation-test',
      redirect_uris: redirectUri,
      scopes: scope,
    }),
  });
  if (!appResponse.ok) {
    throw new Error(`The peer refused the application: ${await appResponse.text()}`);
  }
  const app = (await appResponse.json()) as { client_id: string; client_secret: string };

  const jar = new CookieJar();
  const authorizeQuery = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
  });

  let response = await fetch(`${origin}/oauth/authorize?${authorizeQuery}`, {
    redirect: 'manual',
    headers: { cookie: jar.header() },
  });
  jar.absorb(response);

  let html = await response.text();
  let location = response.headers.get('location') ?? '';

  // The instance sends the browser to the sign in page.
  for (let hop = 0; hop < 3 && location && !html.includes('name="username"'); hop++) {
    response = await fetch(new URL(location, origin), {
      redirect: 'manual',
      headers: { cookie: jar.header() },
    });
    jar.absorb(response);
    html = await response.text();
    location = response.headers.get('location') ?? '';
  }

  // The instance asks for the sign in first.
  if (html.includes('name="username"')) {
    const signIn = parseForm(html);
    const body = new URLSearchParams({ ...(signIn?.fields ?? {}), username, password });
    response = await fetch(`${origin}${signIn?.action ?? '/auth/sign_in'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body,
      redirect: 'manual',
    });
    jar.absorb(response);
    location = response.headers.get('location') ?? '';

    if (location) {
      response = await fetch(new URL(location, origin), {
        redirect: 'manual',
        headers: { cookie: jar.header() },
      });
      jar.absorb(response);
      html = await response.text();
      location = response.headers.get('location') ?? '';
    }
  }

  let code = new URL(location, origin).searchParams.get('code');
  if (!code) {
    // The instance asks for the approval of the application.
    const consent = parseForm(html);
    if (!consent) {
      throw new Error(`The peer did not return an authorization code: ${html.slice(0, 200)}`);
    }
    const body = new URLSearchParams({ ...consent.fields, approve: 'true' });
    response = await fetch(new URL(consent.action, origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body,
      redirect: 'manual',
    });
    jar.absorb(response);
    location = response.headers.get('location') ?? '';
    code = new URL(location, origin).searchParams.get('code');
  }

  if (!code) {
    throw new Error(`The peer did not return an authorization code (status ${response.status})`);
  }

  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.client_id,
      client_secret: app.client_secret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`The peer refused the token: ${await tokenResponse.text()}`);
  }
  const token = (await tokenResponse.json()) as { access_token: string };
  return token.access_token;
}

/** A client of the Mastodon compatible API of a peer. */
export class PeerClient {
  private readonly origin: string;
  private readonly token: string;

  constructor(origin: string, token: string) {
    this.origin = origin;
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async account(username: string): Promise<PeerAccount> {
    const account = await this.request<{
      id: string;
      username: string;
      url: string;
      uri?: string;
      inbox_url?: string;
    }>(`/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`);
    // The ActivityPub actor of the account is the `uri`; the `url` is the
    // profile page of the instance.
    const actorUrl = account.uri ?? account.url;
    return {
      id: account.id,
      username: account.username,
      actorUrl,
      inboxUrl: account.inbox_url ?? `${actorUrl}/inbox`,
    };
  }

  /**
   * Change the settings of the account of the peer.
   *
   * An account that is created by the admin tool of GoToSocial asks for the
   * approval of every follow request, which would keep the federation test
   * from running.
   */
  async updateAccount(settings: Record<string, unknown>): Promise<void> {
    await this.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }

  async post(text: string): Promise<PeerStatus> {
    const status = await this.request<{ id: string; content: string; url: string }>('/api/v1/statuses', {
      method: 'POST',
      body: JSON.stringify({ status: text }),
    });
    return { id: status.id, content: status.content, url: status.url };
  }

  async timeline(): Promise<PeerStatus[]> {
    const statuses = await this.request<Array<{ id: string; content: string; url: string }>>('/api/v1/timelines/home');
    return statuses.map((status) => ({ id: status.id, content: status.content, url: status.url }));
  }

  /** Look an account up by its handle, for example `alice@example.org`. */
  async lookup(handle: string): Promise<PeerAccount | null> {
    try {
      return await this.account(handle);
    } catch {
      return null;
    }
  }

  async follow(accountId: string): Promise<void> {
    await this.request(`/api/v1/accounts/${encodeURIComponent(accountId)}/follow`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async following(accountId: string): Promise<string[]> {
    const following = await this.request<Array<{ url: string }>>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/following?limit=80`,
    );
    return following.map((entry) => entry.url);
  }

  async followers(accountId: string): Promise<string[]> {
    const followers = await this.request<Array<{ url: string }>>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/followers?limit=80`,
    );
    return followers.map((follower) => follower.url);
  }
}

/** GoToSocial: one container, SQLite, no other service. */
export class GoToSocialPeer implements FederationPeer {
  readonly name = 'gotosocial';
  readonly origin: string;
  private readonly container: string;
  private client: PeerClient | null = null;

  constructor(options: { port?: number; image?: string; username?: string; password?: string } = {}) {
    this.origin = `http://localhost:${options.port ?? 8080}`;
    this.container = `flaxia-federation-gotosocial-${process.pid}`;
    this.username = options.username ?? 'peer';
    this.password = options.password ?? 'peer-password-1234';
    this.image = options.image ?? 'superseriousbusiness/gotosocial:0.22.2';
  }

  private readonly username: string;
  private readonly password: string;
  private readonly image: string;

  async start(): Promise<void> {
    docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      this.container,
      '--network',
      'host',
      '--env',
      `GTS_HOST=${new URL(this.origin).host}`,
      '--env',
      'GTS_PROTOCOL=http',
      '--env',
      'GTS_DB_TYPE=sqlite',
      '--env',
      'GTS_DB_ADDRESS=/gotosocial/storage/sqlite.db',
      '--env',
      'GTS_HTTP_CLIENT_ALLOW_IPS=127.0.0.1/32,::1/128',
      '--env',
      'GTS_HTTP_CLIENT_INSECURE_OUTGOING=true',
      '--env',
      'GTS_OPEN_REGISTRATION=true',
      '--env',
      'GTS_LOG_LEVEL=error',
      this.image,
    ]);

    await waitForHttp(`${this.origin}/`, 180_000);

    // The account is created with the admin tool of the instance: the client
    // API needs an account before it can be used.
    docker([
      'exec',
      this.container,
      '/gotosocial/gotosocial',
      'admin',
      'account',
      'create',
      '--username',
      this.username,
      '--email',
      `${this.username}@example.com`,
      '--password',
      this.password,
    ]);

    // The instance caches its accounts, so the new account only becomes
    // visible after a restart.
    docker(['restart', this.container]);
    await waitForHttp(`${this.origin}/`, 180_000);

    this.client = new PeerClient(
      this.origin,
      await loginWithPassword(this.origin, `${this.username}@example.com`, this.password),
    );
    // The account of the peer approves the follow requests right away.
    await this.client.updateAccount({ locked: false, discoverable: true });
  }

  async stop(): Promise<void> {
    try {
      docker(['rm', '--force', this.container]);
    } catch {
      // the container may already be gone
    }
    this.client = null;
  }

  private requireClient(): PeerClient {
    if (!this.client) throw new Error('The peer is not started');
    return this.client;
  }

  async account(): Promise<PeerAccount> {
    return this.requireClient().account(this.username);
  }

  /**
   * Change the settings of the account of the peer.
   *
   * An account that is created by the admin tool of GoToSocial asks for the
   * approval of every follow request, which would keep the federation test
   * from running.
   */
  async updateAccount(settings: Record<string, unknown>): Promise<void> {
    await this.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }

  async post(text: string): Promise<PeerStatus> {
    return this.requireClient().post(text);
  }

  async timeline(): Promise<PeerStatus[]> {
    return this.requireClient().timeline();
  }

  async follow(accountId: string): Promise<void> {
    await this.requireClient().follow(accountId);
  }

  async following(): Promise<string[]> {
    const account = await this.account();
    return this.requireClient().following(account.id);
  }

  async followers(): Promise<string[]> {
    const account = await this.account();
    return this.requireClient().followers(account.id);
  }

  async lookup(handle: string): Promise<PeerAccount | null> {
    return this.requireClient().lookup(handle);
  }

  async actorDocument(): Promise<Record<string, unknown>> {
    const account = await this.account();
    const response = await fetch(account.actorUrl, { headers: { Accept: 'application/activity+json' } });
    return (await response.json()) as Record<string, unknown>;
  }
}

/** Mastodon: Postgres, Redis and three services. */
export class MastodonPeer implements FederationPeer {
  readonly name = 'mastodon';
  readonly origin: string;
  private readonly project: string;

  constructor(options: { port?: number; username?: string; password?: string } = {}) {
    this.origin = `http://localhost:${options.port ?? 8080}`;
    this.project = `flaxia-federation-mastodon-${process.pid}`;
    this.username = options.username ?? 'peer';
    this.password = options.password ?? 'peer-password-1234';
  }

  private readonly username: string;
  private readonly password: string;
  private client: PeerClient | null = null;

  async start(): Promise<void> {
    const compose = ['compose', '--project-name', this.project, '--file', 'tests/federation/mastodon/compose.yaml'];
    const up = spawnSync('docker', [...compose, 'up', '--detach'], { encoding: 'utf8' });
    if (up.status !== 0) {
      throw new Error(`docker compose up failed: ${up.stderr || up.stdout}`);
    }

    await waitForHttp(`${this.origin}/`, 600_000);

    const created = spawnSync(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'web',
        'bin/tootctl',
        'accounts',
        'create',
        this.username,
        '--email',
        `${this.username}@example.com`,
        '--password',
        this.password,
        '--confirmed',
      ],
      { encoding: 'utf8' },
    );
    if (created.status !== 0) {
      throw new Error(`Could not create the account of the peer: ${created.stderr || created.stdout}`);
    }

    this.client = new PeerClient(this.origin, await loginWithPassword(this.origin, this.username, this.password));
    await this.client.updateAccount({ locked: false, discoverable: true });
  }

  async stop(): Promise<void> {
    const compose = ['compose', '--project-name', this.project, '--file', 'tests/federation/mastodon/compose.yaml'];
    spawnSync('docker', [...compose, 'down', '--volumes'], { encoding: 'utf8' });
    this.client = null;
  }

  private requireClient(): PeerClient {
    if (!this.client) throw new Error('The peer is not started');
    return this.client;
  }

  async account(): Promise<PeerAccount> {
    return this.requireClient().account(this.username);
  }

  /**
   * Change the settings of the account of the peer.
   *
   * An account that is created by the admin tool of GoToSocial asks for the
   * approval of every follow request, which would keep the federation test
   * from running.
   */
  async updateAccount(settings: Record<string, unknown>): Promise<void> {
    await this.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }

  async post(text: string): Promise<PeerStatus> {
    return this.requireClient().post(text);
  }

  async timeline(): Promise<PeerStatus[]> {
    return this.requireClient().timeline();
  }

  async follow(accountId: string): Promise<void> {
    await this.requireClient().follow(accountId);
  }

  async following(): Promise<string[]> {
    const account = await this.account();
    return this.requireClient().following(account.id);
  }

  async followers(): Promise<string[]> {
    const account = await this.account();
    return this.requireClient().followers(account.id);
  }

  async lookup(handle: string): Promise<PeerAccount | null> {
    return this.requireClient().lookup(handle);
  }

  async actorDocument(): Promise<Record<string, unknown>> {
    const account = await this.account();
    const response = await fetch(account.actorUrl, { headers: { Accept: 'application/activity+json' } });
    return (await response.json()) as Record<string, unknown>;
  }
}

/** The peer the tests run against. */
export function createPeer(kind: string): FederationPeer {
  if (kind === 'gotosocial') return new GoToSocialPeer();
  if (kind === 'mastodon') return new MastodonPeer();
  throw new Error(`Unknown peer: ${kind}`);
}
