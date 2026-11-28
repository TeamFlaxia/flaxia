/**
 * RFC 9421 (HTTP Message Signatures) verification for ActivityPub.
 *
 * Kept separate from the draft-cavage implementation so neither format's
 * parsing rules leak into the other. This module performs no network access:
 * key resolution stays in `fetch.ts`.
 */
import { importPublicKey } from './crypto.ts';

/** A single labelled signature from `Signature-Input` / `Signature`. */
export interface Rfc9421SignatureInput {
  label: string;
  components: string[];
  params: Array<{ name: string; value: string }>;
  signature: string;
}

export interface Rfc9421VerifyOptions {
  expectedHost?: string;
  maxSkewMs?: number;
  now?: number;
}

const DEFAULT_MAX_SKEW_MS = 30 * 60 * 1000;
/** Fixed grace after `expires`: the 30 minute clock skew must not extend it. */
export const EXPIRES_TOLERANCE_MS = 60_000;
/** Algorithms this verifier can actually check with RSASSA-PKCS1-v1_5. */
const ALLOWED_ALGORITHMS = new Set(['rsa-sha256', 'rsa-v1_5-sha256']);

/** Split on separators that are not inside a quoted string. */
function splitOutsideQuotes(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === separator && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function unquoteRfc9421(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replace(/\\"/g, '"') : trimmed;
}

/** Parse every labelled signature in a pair of RFC 9421 headers. */
export function parseRfc9421Signatures(signatureInput: string, signatureHeader: string): Rfc9421SignatureInput[] {
  const signatures = new Map<string, string>();
  for (const item of splitOutsideQuotes(signatureHeader, ',')) {
    const match = item.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*:([^:]*):$/);
    if (match && !signatures.has(match[1])) signatures.set(match[1], match[2]);
  }

  const parsed: Rfc9421SignatureInput[] = [];
  for (const item of splitOutsideQuotes(signatureInput, ',')) {
    const match = item.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*\(([^)]*)\)(.*)$/);
    if (!match) continue;
    const label = match[1];
    const signature = signatures.get(label);
    if (!signature) continue;
    const components = match[2]
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(unquoteRfc9421)
      .map((component) => component.toLowerCase());
    if (components.length === 0) continue;

    const params: Array<{ name: string; value: string }> = [];
    for (const part of splitOutsideQuotes(match[3], ';')) {
      const parameter = part.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      // Keep the serialized form: quoted values stay quoted in the signature
      // base (RFC 9421 §2.1), and are only unquoted when read as numbers.
      if (parameter) params.push({ name: parameter[1].toLowerCase(), value: parameter[2].trim() });
    }
    parsed.push({ label, components, params, signature });
  }
  return parsed;
}

/** Read a parameter (e.g. `keyid`, `created`) from RFC 9421 signatures, unquoted. */
export function rfc9421Param(signatures: Rfc9421SignatureInput[], name: string): string | undefined {
  const target = name.toLowerCase();
  for (const signature of signatures) {
    const parameter = signature.params.find((entry) => entry.name === target);
    if (parameter) return unquoteRfc9421(parameter.value);
  }
  return undefined;
}

/** Resolve one RFC 9421 component identifier to its signature-base value. */
function rfc9421ComponentValue(request: Request, component: string, params: Map<string, string>): string | null {
  const url = new URL(request.url);
  switch (component) {
    case '@method':
      return request.method.toUpperCase();
    case '@target-uri':
      return request.url;
    case '@request-target':
    case '(request-target)':
      return url.pathname + url.search;
    case '@authority':
      return url.host;
    case '@scheme':
      return url.protocol.replace(/:$/, '');
    case '@path':
      return url.pathname;
    case '@query':
      return url.search;
    case '(created)':
      return params.get('created') ?? null;
    case '(expires)':
      return params.get('expires') ?? null;
    case 'host':
      return request.headers.get('host') ?? url.host;
    default:
      return request.headers.get(component);
  }
}

/** Build the RFC 9421 signature base, or null when a component is unavailable. */
export function buildRfc9421SignatureBase(
  request: Request,
  components: string[],
  params: Array<{ name: string; value: string }>,
): string | null {
  const values = new Map(params.map((parameter) => [parameter.name, parameter.value]));
  const lines: string[] = [];
  for (const component of components) {
    const value = rfc9421ComponentValue(request, component, values);
    if (value === null) return null;
    lines.push(`"${component}": ${value}`);
  }
  for (const parameter of params) lines.push(`"${parameter.name}": ${parameter.value}`);
  return lines.join('\n');
}

/** Verify a request signed with RFC 9421 headers. Any valid label wins. */
export async function verifyRfc9421Signature(
  request: Request,
  publicKeyPem: string,
  options: Rfc9421VerifyOptions,
  decodeSignature: (value: string) => Uint8Array<ArrayBuffer> | null,
): Promise<boolean> {
  const signatureInput = request.headers.get('Signature-Input');
  const signatureHeader = request.headers.get('Signature');
  if (!signatureInput || !signatureHeader) return false;

  const candidates = parseRfc9421Signatures(signatureInput, signatureHeader);
  if (candidates.length === 0) return false;

  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const now = options.now ?? Date.now();
  const url = new URL(request.url);
  const requestHost = request.headers.get('host') ?? url.host;
  const targetComponents = new Set(['@target-uri', '@request-target', '(request-target)', '@path']);
  const encoder = new TextEncoder();
  let publicKey: CryptoKey | undefined;

  for (const candidate of candidates) {
    const params = new Map(candidate.params.map((parameter) => [parameter.name, parameter.value]));
    const created = params.has('created') ? Number(unquoteRfc9421(params.get('created') ?? '')) : undefined;
    const expires = params.has('expires') ? Number(unquoteRfc9421(params.get('expires') ?? '')) : undefined;
    // `created` is the only freshness signal when the signer omits Date, so
    // bound it in both directions to keep old deliveries from being replayed.
    if (created !== undefined && (!Number.isFinite(created) || Math.abs(now - created * 1000) > maxSkewMs)) continue;
    if (expires !== undefined && (!Number.isFinite(expires) || expires * 1000 + EXPIRES_TOLERANCE_MS <= now)) {
      continue;
    }
    const alg = params.has('alg') ? unquoteRfc9421(params.get('alg') ?? '').toLowerCase() : undefined;
    if (alg !== undefined && !ALLOWED_ALGORITHMS.has(alg)) continue;

    const dateHeader = request.headers.get('date');
    if (!dateHeader && created === undefined) continue;
    if (dateHeader) {
      const requestTime = new Date(dateHeader).getTime();
      if (Number.isNaN(requestTime) || Math.abs(now - requestTime) > maxSkewMs) continue;
    }

    // A signature that does not cover the target or the body can be replayed
    // against a different endpoint or with a different payload.
    if (!candidate.components.some((component) => targetComponents.has(component))) continue;
    if (request.method.toUpperCase() !== 'GET' && !candidate.components.includes('@method')) continue;
    if (
      !['GET', 'HEAD'].includes(request.method.toUpperCase()) &&
      !candidate.components.includes('content-digest') &&
      !candidate.components.includes('digest')
    ) {
      continue;
    }

    // A signed host must name the host the request actually addresses. When
    // neither a host nor a full target URI is signed, only the path is bound,
    // so the expected host is the remaining protection against a signature
    // replayed on another instance (an inbox delivery is addressed to us, not
    // to the actor's own host).
    const bindsHost = candidate.components.includes('host') || candidate.components.includes('@authority');
    const bindsFullTarget = candidate.components.includes('@target-uri');
    if (bindsHost && requestHost !== url.host) continue;
    if (options.expectedHost && !bindsHost && !bindsFullTarget && url.host !== options.expectedHost) continue;

    const base = buildRfc9421SignatureBase(request, candidate.components, candidate.params);
    if (base === null) continue;
    const signatureBytes = decodeSignature(candidate.signature);
    if (!signatureBytes) continue;

    publicKey ??= await importPublicKey(publicKeyPem);
    try {
      if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signatureBytes, encoder.encode(base))) {
        return true;
      }
    } catch {
      // Try the next label.
    }
  }
  return false;
}
