/// <reference types="@cloudflare/workers-types" />
import { fetchWithSsrfGuard, parsePublicHttpUrl, SsrfError } from '../url-guard.ts';
import { importPublicKey } from './crypto.ts';

/**
 * Parse Signature header
 */
interface SignatureHeader {
  keyId: string;
  headers: string[];
  signature: string;
  algorithm?: string;
}

function parseSignatureHeader(signatureHeader: string): SignatureHeader {
  const result: Record<string, unknown> = {};
  const regex = /(\w+)=("(?:\\.|[^"])*"|[^,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(signatureHeader)) !== null) {
    const key = match[1];
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1).replace(/\\"/g, '"');
    }
    if (key === 'headers') {
      result[key] = value.split(' ');
    } else {
      result[key] = value;
    }
  }

  if (!result.keyId || !result.headers || !result.signature) {
    throw new Error('Invalid signature header format: missing required fields');
  }

  const headers = (result.headers as string[]).map((header) => header.toLowerCase());
  result.headers = headers;
  return result as unknown as SignatureHeader;
}

/**
 * Verify HTTP Signature
 */
export async function verifyHttpSignature(request: Request, publicKeyPem: string): Promise<boolean> {
  try {
    const signatureHeader = request.headers.get('Signature');
    if (!signatureHeader) {
      return false;
    }

    let parsed: SignatureHeader;
    try {
      parsed = parseSignatureHeader(signatureHeader);
    } catch (_error) {
      return false;
    }

    const dateHeader = request.headers.get('Date');
    if (!dateHeader) {
      return false;
    }

    const dateParsed = new Date(dateHeader);
    const requestTime = dateParsed.getTime();
    if (Number.isNaN(requestTime)) {
      return false;
    }

    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;

    if (Math.abs(now - requestTime) > thirtyMinutes) {
      return false;
    }

    const required =
      request.method === 'POST' ? ['(request-target)', 'host', 'date', 'digest'] : ['(request-target)', 'host', 'date'];
    if (!required.every((header) => parsed.headers.includes(header))) return false;

    const signingString = buildSigningString(request, parsed.headers);
    const publicKey = await importPublicKey(publicKeyPem);

    let signatureBase64 = parsed.signature.replace(/\s/g, '');
    signatureBase64 = signatureBase64.replace(/-/g, '+').replace(/_/g, '/');

    while (signatureBase64.length % 4 !== 0) {
      signatureBase64 += '=';
    }

    if (/[^A-Za-z0-9+/=]/.test(signatureBase64)) {
      return false;
    }

    try {
      const signatureString = atob(signatureBase64);
      const signatureArray = new Uint8Array(signatureString.length);
      for (let i = 0; i < signatureString.length; i++) {
        signatureArray[i] = signatureString.charCodeAt(i);
      }

      const encoder = new TextEncoder();
      const signingStringArray = encoder.encode(signingString);

      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signatureArray, signingStringArray);
    } catch (_error) {
      return false;
    }
  } catch (_error) {
    return false;
  }
}

/**
 * Build signing string from headers
 */
function buildSigningString(request: Request, headers: string[]): string {
  const url = new URL(request.url);
  const lines: string[] = [];

  for (const header of headers) {
    const normalized = header.toLowerCase();
    if (normalized === '(request-target)') {
      const method = request.method.toLowerCase();
      const path = url.pathname + url.search;
      lines.push(`(request-target): ${method} ${path}`);
    } else {
      const value = request.headers.get(normalized);
      if (value === null) {
        throw new Error(`Missing required header: ${normalized}`);
      }
      lines.push(`${normalized}: ${value}`);
    }
  }

  return lines.join('\n');
}

/**
 * Verify Digest header
 */
export async function verifyDigest(request: Request, body: string): Promise<boolean> {
  try {
    const digestHeader = request.headers.get('Digest');
    if (!digestHeader) {
      console.error('Missing Digest header');
      return false;
    }

    // Parse Digest header (e.g., "SHA-256=xyz123...")
    const match = digestHeader.match(/sha-256=([A-Za-z0-9+/=]+)/i);
    if (!match) {
      console.error('Invalid Digest header format');
      return false;
    }

    const expectedDigest = match[1];

    // Calculate actual digest
    const encoder = new TextEncoder();
    const data = encoder.encode(body);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const actualDigest = btoa(String.fromCharCode(...hashArray));

    return expectedDigest === actualDigest;
  } catch (error) {
    console.error('Digest verification error:', error);
    return false;
  }
}

/**
 * Fetch actor's public key from their URL
 * Optionally signs the request if privateKeyPem and keyId are provided (for authorized fetch)
 *
 * The actor URL is attacker-controlled (it arrives in the unsigned inbox
 * body), so it goes through the shared SSRF guard: only public http(s)
 * targets pass, every redirect hop is re-validated, and fetches time out.
 */
export async function fetchActorPublicKey(
  actorUrl: string,
  privateKeyPem?: string,
  keyId?: string,
): Promise<string | null> {
  try {
    let response: Response | null = null;

    // If signing keys provided, use signed fetch
    if (privateKeyPem && keyId) {
      response = await signedFetch(actorUrl, privateKeyPem, keyId);
    }

    // Fall back to unsigned fetch if signed fetch failed or no keys provided
    if (!response || !response.ok) {
      try {
        response = await fetchWithSsrfGuard(actorUrl, {
          headers: {
            Accept: 'application/activity+json, application/ld+json',
          },
          timeoutMs: 10000,
        });
      } catch (error: unknown) {
        if (error instanceof SsrfError) {
          console.error('Refusing actor fetch:', (error as Error).message);
          return null;
        }
        throw error;
      }
    }

    if (!response || !response.ok) {
      console.error(`Failed to fetch actor: ${response?.status}`);
      return null;
    }

    const actor = (await response.json()) as { publicKey?: { publicKeyPem?: string } };

    if (!actor.publicKey || !actor.publicKey.publicKeyPem) {
      console.error('Actor missing publicKey.publicKeyPem');
      return null;
    }

    return actor.publicKey.publicKeyPem;
  } catch (error) {
    console.error('Error fetching actor public key:', error);
    return null;
  }
}

/**
 * Import private key from PEM format
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = '-----BEGIN PRIVATE KEY-----';
  const pemFooter = '-----END PRIVATE KEY-----';
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length).replace(/\n/g, '');

  const binaryDerString = atob(pemContents);
  const binaryDerArray = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDerArray[i] = binaryDerString.charCodeAt(i);
  }

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDerArray.buffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    true,
    ['sign'],
  );
}

/**
 * Sign an outgoing ActivityPub request with HTTP Signature
 */
export async function signRequest(url: string, body: string, privateKeyPem: string, keyId: string): Promise<Headers> {
  const headers = new Headers();

  // Calculate digest
  const encoder = new TextEncoder();
  const bodyArray = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bodyArray);
  const hashArray = new Uint8Array(hashBuffer);
  const digest = btoa(String.fromCharCode(...hashArray));

  // Set Date header
  const date = new Date().toUTCString();
  headers.set('Date', date);

  // Set Digest header
  headers.set('Digest', `sha-256=${digest}`);

  // Set Content-Type
  headers.set('Content-Type', 'application/activity+json');

  // Build signing string
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname + parsedUrl.search;
  const signingString = [
    `(request-target): post ${path}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
    `digest: sha-256=${digest}`,
  ].join('\n');

  // Import private key. Never log the signing string or signature: either can
  // expose request details, and the signature can be replayed during its date window.
  const privateKey = await importPrivateKey(privateKeyPem);

  // Sign
  const signingArray = encoder.encode(signingString);

  const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signingArray);

  // Convert signature to base64 (not base64url)
  const signatureArray = new Uint8Array(signatureBuffer);
  const signature = btoa(String.fromCharCode(...signatureArray));

  // Set Signature header
  headers.set(
    'Signature',
    `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
  );

  return headers;
}

/**
 * Perform a signed GET request for ActivityPub (authorized fetch / secure mode).
 * Uses the same signing approach as signRequest but for GET requests (no body/digest).
 */
export async function signedFetch(url: string, privateKeyPem: string, keyId: string): Promise<Response | null> {
  try {
    // The URL is remote input: reject non-public targets before signing.
    // Redirects are not followed (the signature covers the request target,
    // so a hop would invalidate it anyway).
    try {
      parsePublicHttpUrl(url);
    } catch {
      return null;
    }
    const headers = new Headers();
    headers.set('Accept', 'application/activity+json, application/ld+json');
    headers.set('Date', new Date().toUTCString());

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname + parsedUrl.search;
    const signingString = [
      `(request-target): get ${path}`,
      `host: ${parsedUrl.host}`,
      `date: ${headers.get('Date')}`,
    ].join('\n');

    const encoder = new TextEncoder();
    const signingArray = encoder.encode(signingString);
    const privateKey = await importPrivateKey(privateKeyPem);
    const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signingArray);
    const signatureArray = new Uint8Array(signatureBuffer);
    const signature = btoa(String.fromCharCode(...signatureArray));

    headers.set(
      'Signature',
      `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
    );

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    return response;
  } catch {
    console.error('Signed GET request failed');
    return null;
  }
}
