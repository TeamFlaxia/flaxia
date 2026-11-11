/// <reference types="@cloudflare/workers-types" />

import { importPublicKey } from './crypto.ts';

/**
 * HTTP Signatures (draft-cavage-http-signatures-12) for ActivityPub.
 *
 * The module is deliberately free of network access: it only parses,
 * builds and verifies signatures. Fetching the key that a signature refers to
 * lives in `fetch.ts`, which applies the SSRF guard.
 */

export interface SignatureHeader {
  keyId: string;
  headers: string[];
  signature: string;
  algorithm?: string;
  /** Unix seconds; when present the signature is only valid from that moment. */
  created?: number;
  /** Unix seconds; when present the signature expires at that moment. */
  expires?: number;
}

export interface VerifyOptions {
  /**
   * Host the request is expected to be addressed to. Used when the peer did
   * not sign the `host` header: a signature that does not bind the host must
   * not be accepted for a host other than the actor's own origin.
   */
  expectedHost?: string;
  /** Maximum accepted clock skew of the `Date` header, in milliseconds. */
  maxSkewMs?: number;
  /** Verify the `created`/`expires` parameters of the signature. */
  now?: number;
}

const DEFAULT_MAX_SKEW_MS = 30 * 60 * 1000;

/**
 * Parse a `Signature` header.
 *
 * Peers differ in quoting and in the order of the parameters, so the parser
 * accepts quoted and unquoted values and tolerates escaped quotes.
 */
export function parseSignatureHeader(signatureHeader: string): SignatureHeader {
  const result: Record<string, string | string[]> = {};
  const regex = /([a-zA-Z]+)=("(?:\\.|[^"])*"|[^,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(signatureHeader)) !== null) {
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1).replace(/\\"/g, '"');
    }
    if (key === 'headers') {
      result[key] = value.split(/\s+/).filter(Boolean);
    } else {
      result[key] = value;
    }
  }

  const keyId = result.keyid;
  const headers = result.headers;
  const signature = result.signature;
  if (typeof keyId !== 'string' || !Array.isArray(headers) || typeof signature !== 'string') {
    throw new Error('Invalid signature header format: missing required fields');
  }
  if (headers.length === 0) {
    throw new Error('Invalid signature header format: no signed headers');
  }

  const parsed: SignatureHeader = {
    keyId,
    headers: headers.map((header) => header.toLowerCase()),
    signature,
  };
  if (typeof result.algorithm === 'string') parsed.algorithm = result.algorithm;
  if (typeof result.created === 'string') {
    const created = Number.parseInt(result.created, 10);
    if (Number.isFinite(created)) parsed.created = created;
  }
  if (typeof result.expires === 'string') {
    const expires = Number.parseInt(result.expires, 10);
    if (Number.isFinite(expires)) parsed.expires = expires;
  }
  return parsed;
}

/**
 * Build the signing string of a request.
 *
 * `(request-target)` is expanded to the method and the request target, every
 * other entry is the header value with the original casing preserved for the
 * header name in lower case.
 */
export function buildSigningString(request: Request, headers: string[]): string {
  const url = new URL(request.url);
  const lines: string[] = [];

  for (const header of headers) {
    const normalized = header.toLowerCase();
    if (normalized === '(request-target)') {
      const method = request.method.toLowerCase();
      const path = url.pathname + url.search;
      lines.push(`(request-target): ${method} ${path}`);
    } else if (normalized === '(created)') {
      lines.push('(created): 0');
    } else if (normalized === 'host') {
      // The host is not always part of the request headers: a runtime that
      // strips it still lets the URL name the host the request addresses.
      const value = request.headers.get('host') ?? hostOf(request.url);
      if (!value) {
        throw new Error('Missing required header: host');
      }
      lines.push(`host: ${value}`);
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Verify the HTTP signature of a request.
 *
 * The signed header list must always cover the request target and the date.
 * A request with a body must additionally cover the digest, otherwise the
 * body could be replaced without invalidating the signature.
 */
export async function verifyHttpSignature(
  request: Request,
  publicKeyPem: string,
  options: VerifyOptions = {},
): Promise<boolean> {
  try {
    const signatureHeader = request.headers.get('Signature');
    if (!signatureHeader) {
      return false;
    }

    let parsed: SignatureHeader;
    try {
      parsed = parseSignatureHeader(signatureHeader);
    } catch {
      return false;
    }

    const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    const now = options.now ?? Date.now();

    const dateHeader = request.headers.get('Date');
    if (!dateHeader) {
      return false;
    }
    const requestTime = new Date(dateHeader).getTime();
    if (Number.isNaN(requestTime)) {
      return false;
    }
    if (Math.abs(now - requestTime) > maxSkewMs) {
      return false;
    }

    if (parsed.created !== undefined && parsed.created * 1000 > now + maxSkewMs) {
      return false;
    }
    if (parsed.expires !== undefined && parsed.expires * 1000 < now - maxSkewMs) {
      return false;
    }

    const required = request.method === 'POST' ? ['(request-target)', 'date', 'digest'] : ['(request-target)', 'date'];
    if (!required.every((header) => parsed.headers.includes(header))) return false;

    const requestHost = request.headers.get('host') ?? hostOf(request.url);
    if (parsed.headers.includes('host')) {
      const signedHost = request.headers.get('host') ?? hostOf(request.url);
      if (!signedHost || signedHost !== requestHost) return false;
    } else if (options.expectedHost && requestHost !== options.expectedHost) {
      // The peer did not bind the signature to a host, so it must at least be
      // addressed to the host the actor lives on.
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
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Verify the `Digest` header of a request against its body.
 */
export async function verifyDigest(request: Request, body: string): Promise<boolean> {
  try {
    const digestHeader = request.headers.get('Digest');
    if (!digestHeader) {
      return false;
    }

    const match = digestHeader.match(/sha-256=([A-Za-z0-9+/=]+)/i);
    if (!match) {
      return false;
    }

    const expectedDigest = match[1];
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(body));
    const hashArray = new Uint8Array(hashBuffer);
    const actualDigest = btoa(String.fromCharCode(...hashArray));

    return expectedDigest === actualDigest;
  } catch {
    return false;
  }
}

/**
 * Import a private key from PEM format.
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
 * Sign an outgoing ActivityPub request with an HTTP signature.
 *
 * The signature covers the request target, the host, the date and the digest
 * of the body, which is what every current implementation expects.
 */
export async function signRequest(url: string, body: string, privateKeyPem: string, keyId: string): Promise<Headers> {
  const headers = new Headers();

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const hashArray = new Uint8Array(hashBuffer);
  const digest = btoa(String.fromCharCode(...hashArray));

  const date = new Date().toUTCString();
  headers.set('Date', date);
  headers.set('Digest', `sha-256=${digest}`);
  headers.set('Content-Type', 'application/activity+json');

  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname + parsedUrl.search;
  const signingString = [
    `(request-target): post ${path}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
    `digest: sha-256=${digest}`,
  ].join('\n');

  const privateKey = await importPrivateKey(privateKeyPem);
  const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(signingString));
  const signatureArray = new Uint8Array(signatureBuffer);
  const signature = btoa(String.fromCharCode(...signatureArray));

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
    const date = new Date().toUTCString();
    headers.set('Date', date);

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname + parsedUrl.search;
    const signingString = [`(request-target): get ${path}`, `host: ${parsedUrl.host}`, `date: ${date}`].join('\n');

    const encoder = new TextEncoder();
    const privateKey = await importPrivateKey(privateKeyPem);
    const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(signingString));
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
    return null;
  }
}
