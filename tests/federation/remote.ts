// A remote instance for the federation tests.
//
// The harness plays the role of the instance on the other side of the
// federation: it publishes an actor document, signs the activities it sends
// and records everything an instance delivers to it. The recorded deliveries
// are the ground truth of the differential test: they show what the instance
// under test actually sends, with the signature it signed it with.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importPrivateKey,
} from '../../functions/lib/activitypub/crypto.ts';
import { signRequest, verifyDigest, verifyHttpSignature } from '../../functions/lib/activitypub/signature.ts';

export interface RemoteActor {
  username: string;
  actorUrl: string;
  inboxUrl: string;
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface DeliveredActivity {
  activity: Record<string, unknown>;
  /** The body exactly as it was received. */
  body: string;
  headers: Record<string, string>;
  signatureValid: boolean;
  digestValid: boolean;
  receivedAt: string;
}

/** The remote instance of the federation test. */
export class RemoteInstance {
  private server: Server | null = null;
  private port = 0;
  private keyPair: { privateKeyPem: string; publicKeyPem: string } | null = null;
  readonly deliveries: DeliveredActivity[] = [];
  private readonly senderKeys = new Map<string, string>();
  readonly received: DeliveredActivity[] = [];

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get actor(): RemoteActor {
    if (!this.keyPair) throw new Error('The remote instance is not started');
    const actorUrl = `${this.origin}/users/alice`;
    return {
      username: 'alice',
      actorUrl,
      inboxUrl: `${actorUrl}/inbox`,
      keyId: `${actorUrl}#main-key`,
      publicKeyPem: this.keyPair.publicKeyPem,
      privateKeyPem: this.keyPair.privateKeyPem,
    };
  }

  /** The handle a peer uses to address the remote account. */
  get handle(): string {
    return `alice@127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const pair = await generateKeyPair();
    this.keyPair = {
      privateKeyPem: await exportPrivateKey(pair.privateKey),
      publicKeyPem: await exportPublicKey(pair.publicKey),
    };

    const server = createServer((req, res) => {
      void this.respond(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    this.port = (server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);

    if (req.method === 'GET' && url.pathname === '/users/alice') {
      const actor = this.actor;
      res.writeHead(200, { 'Content-Type': 'application/activity+json' });
      res.end(
        JSON.stringify({
          '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
          id: actor.actorUrl,
          type: 'Person',
          preferredUsername: actor.username,
          name: 'Remote Alice',
          summary: 'The other side of the federation test',
          url: `${this.origin}/@alice`,
          inbox: actor.inboxUrl,
          outbox: `${this.origin}/users/alice/outbox`,
          followers: `${this.origin}/users/alice/followers`,
          following: `${this.origin}/users/alice/following`,
          liked: `${this.origin}/users/alice/liked`,
          endpoints: { sharedInbox: `${this.origin}/inbox` },
          publicKey: {
            id: actor.keyId,
            owner: actor.actorUrl,
            publicKeyPem: actor.publicKeyPem,
          },
        }),
      );
      return;
    }

    // The discovery documents of the remote instance. An instance resolves
    // the account of a remote actor with them.
    if (req.method === 'GET' && url.pathname === '/.well-known/webfinger') {
      const actor = this.actor;
      res.writeHead(200, { 'Content-Type': 'application/jrd+json' });
      res.end(
        JSON.stringify({
          subject: `acct:${actor.username}@${new URL(this.origin).host}`,
          links: [
            { rel: 'self', type: 'application/activity+json', href: actor.actorUrl },
            {
              rel: 'http://webfinger.net/rel/profile-page',
              type: 'text/html',
              href: `${this.origin}/@${actor.username}`,
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/host-meta') {
      res.writeHead(200, { 'Content-Type': 'application/xrd+xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" template="${this.origin}/.well-known/webfinger?resource={uri}"/>
</XRD>`,
      );
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/inbox')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[name] = value;
      }

      let activity: Record<string, unknown> = {};
      try {
        activity = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      const request = new Request(`http://127.0.0.1:${this.port}${url.pathname}`, {
        method: 'POST',
        headers,
        body,
      });

      // The signature is verified with the key of the sender: the key is
      // fetched from the document the key id points at.
      const signatureValid = await this.verifySenderSignature(request);
      const digestValid = await verifyDigest(request, body);

      this.deliveries.push({
        activity,
        body,
        headers,
        signatureValid,
        digestValid,
        receivedAt: new Date().toISOString(),
      });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  /**
   * The key of a sender, fetched once and kept.
   *
   * The key is fetched before the delivery is answered: the instance that
   * sends the activity waits for the answer, so a fetch that needs the
   * instance would block the delivery.
   */
  async primeSenderKey(actorUrl: string): Promise<void> {
    const keyUrl = actorUrl.replace(/#.*$/, '');
    try {
      const response = await fetch(keyUrl, {
        headers: { Accept: 'application/activity+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const document = (await response.json()) as {
        publicKey?: { publicKeyPem?: string };
        publicKeyPem?: string;
      };
      const pem = document.publicKey?.publicKeyPem ?? document.publicKeyPem;
      if (pem) this.senderKeys.set(keyUrl, pem);
    } catch {
      // the key is fetched again when the delivery arrives
    }
  }

  /** Verify the signature of a delivery with the key of its sender. */
  private async verifySenderSignature(request: Request): Promise<boolean> {
    const signatureHeader = request.headers.get('Signature');
    if (!signatureHeader) return false;
    const keyId = /keyId="([^"]+)"/.exec(signatureHeader)?.[1];
    if (!keyId) return false;
    try {
      const keyUrl = keyId.replace(/#.*$/, '');
      let pem = this.senderKeys.get(keyUrl);
      if (!pem) {
        const response = await fetch(keyUrl, {
          headers: { Accept: 'application/activity+json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return false;
        const document = (await response.json()) as {
          publicKey?: { publicKeyPem?: string };
          publicKeyPem?: string;
        };
        pem = document.publicKey?.publicKeyPem ?? document.publicKeyPem;
        if (!pem) return false;
        this.senderKeys.set(keyUrl, pem);
      }
      const url = new URL(request.url);
      return await verifyHttpSignature(request, pem, { expectedHost: url.host });
    } catch {
      return false;
    }
  }

  /**
   * Fetch a document of another instance with a signed request.
   *
   * An instance that runs in secure mode only answers a signed request.
   */
  async signedGet(url: string): Promise<Record<string, unknown> | null> {
    const headers = new Headers();
    headers.set('Accept', 'application/activity+json, application/ld+json');
    headers.set('User-Agent', 'Flaxia federation test');
    const date = new Date().toUTCString();
    headers.set('Date', date);
    const parsed = new URL(url);
    const signingString = [
      `(request-target): get ${parsed.pathname}${parsed.search}`,
      `host: ${parsed.host}`,
      `date: ${date}`,
    ].join('\n');
    const encoder = new TextEncoder();
    const key = await importPrivateKey(this.actor.privateKeyPem);
    const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingString));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    headers.set(
      'Signature',
      `keyId="${this.actor.keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
    );

    const response = await fetch(url, { headers, redirect: 'manual' });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  }

  /** Send an activity to the inbox of an instance, signed with the actor key. */
  async deliver(inboxUrl: string, activity: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify(activity);
    const headers = await signRequest(inboxUrl, body, this.actor.privateKeyPem, this.actor.keyId);
    const response = await fetch(inboxUrl, { method: 'POST', headers, body });
    return response;
  }

  /** The delivery of an activity type, if it arrived. */
  deliveryOf(type: string): DeliveredActivity | undefined {
    return [...this.deliveries].reverse().find((delivery) => delivery.activity.type === type);
  }
}
