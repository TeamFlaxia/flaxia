/// <reference types="@cloudflare/workers-types" />
import { importPublicKey } from './crypto';

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
    if (header === '(request-target)') {
      const method = request.method.toLowerCase();
      const path = url.pathname + url.search;
      lines.push(`(request-target): ${method} ${path}`);
    } else {
      const value = request.headers.get(header);
      if (value === null) {
        throw new Error(`Missing required header: ${header}`);
      }
      lines.push(`${header}: ${value}`);
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
    const match = digestHeader.match(/SHA-256=([A-Za-z0-9+/=]+)/);
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
      response = await fetch(actorUrl, {
        headers: {
          Accept: 'application/activity+json, application/ld+json',
        },
      });
    }

    if (!response.ok) {
      console.error(`Failed to fetch actor: ${response.status}`);
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
export async function signRequest(
  url: string,
  body: string,
  privateKeyPem: string,
  publicKeyPem: string,
  keyId: string,
): Promise<Headers> {
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

  console.log('Signing string:');
  console.log(signingString);

  // Import private key
  console.log('Importing private key for signing...');
  const privateKey = await importPrivateKey(privateKeyPem);
  console.log('Private key imported successfully');

  // Sign
  const signingArray = encoder.encode(signingString);
  console.log('Signing string length:', signingString.length);
  console.log('Signing string (first 200 chars):', signingString.substring(0, 200));

  const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signingArray);

  // Convert signature to base64 (not base64url)
  const signatureArray = new Uint8Array(signatureBuffer);
  const signature = btoa(String.fromCharCode(...signatureArray));

  console.log('Signature generated successfully, length:', signature.length);
  console.log('Signature (first 50 chars):', signature.substring(0, 50));

  // Verify our own signature for debugging
  try {
    console.log('Verifying our own signature...');
    const publicKey = await importPublicKey(publicKeyPem);
    const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signatureArray, signingArray);
    console.log('Self-verification result:', isValid);
    if (!isValid) {
      console.error('WARNING: Our own signature verification failed!');
    }
  } catch (error) {
    console.error('Self-verification error:', error);
  }

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
      signal: AbortSignal.timeout(15000),
    });

    return response;
  } catch (error) {
    console.error('Signed GET error:', error);
    return null;
  }
}
