/// <reference types="@cloudflare/workers-types" />

/**
 * Decode the base64 content of a PEM block.
 *
 * Keys are usually encoded with the standard alphabet, but some instances
 * publish them with the url safe alphabet or with a trailing character
 * outside the alphabet. The content is decoded as it is and, when that
 * fails, without the trailing characters. The key itself is verified by
 * every signature that is checked with it.
 */
function decodePem(contents: string): Uint8Array<ArrayBuffer> {
  const variants = [contents, contents.replace(/[^A-Za-z0-9+/=]+$/, '')];

  for (const variant of variants) {
    const normalized = variant.replace(/-/g, '+').replace(/_/g, '/');
    if (/[^A-Za-z0-9+/=]/.test(normalized)) continue;

    let padded = normalized;
    while (padded.length % 4 !== 0) {
      padded += '=';
    }

    try {
      const binary = atob(padded);
      const bytes = new Uint8Array(new ArrayBuffer(binary.length));
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {}
  }

  throw new Error('Failed to decode PEM base64 content');
}

/**
 * Generate RSA-SHA256 key pair for ActivityPub
 */
export async function generateKeyPair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: 'SHA-256',
    },
    true, // extractable
    ['sign', 'verify'],
  );

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  };
}

/**
 * Export public key to PEM format
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', key);
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported));
  const exportedAsBase64 = btoa(exportedAsString);
  const pemHeader = '-----BEGIN PUBLIC KEY-----\n';
  const pemFooter = '\n-----END PUBLIC KEY-----';

  // Add line breaks every 64 characters for proper PEM format
  const base64WithLines = exportedAsBase64.match(/.{1,64}/g)?.join('\n') || exportedAsBase64;

  return pemHeader + base64WithLines + pemFooter;
}

/**
 * Export private key to PEM format
 */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('pkcs8', key);
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported));
  const exportedAsBase64 = btoa(exportedAsString);
  const pemHeader = '-----BEGIN PRIVATE KEY-----\n';
  const pemFooter = '\n-----END PRIVATE KEY-----';

  // Add line breaks every 64 characters for proper PEM format
  const base64WithLines = exportedAsBase64.match(/.{1,64}/g)?.join('\n') || exportedAsBase64;

  return pemHeader + base64WithLines + pemFooter;
}

/**
 * Import public key from PEM format
 */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header and footer and clean whitespace
  const pemHeader = '-----BEGIN PUBLIC KEY-----';
  const pemFooter = '-----END PUBLIC KEY-----';
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length).replace(/\s/g, ''); // Remove all whitespace including newlines and spaces

  // Decode base64 using Web Crypto API (Cloudflare Functions compatible)
  const binaryDerArray = decodePem(pemContents);
  return crypto.subtle.importKey(
    'spki',
    binaryDerArray,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    true,
    ['verify'],
  );
}

/**
 * Import private key from PEM format
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header and footer and clean all whitespace
  const pemHeader = '-----BEGIN PRIVATE KEY-----';
  const pemFooter = '-----END PRIVATE KEY-----';
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length).replace(/\s/g, ''); // Remove all whitespace including newlines and spaces

  // Decode base64 using Web Crypto API (Cloudflare Functions compatible)
  try {
    const binaryDerArray = decodePem(pemContents);
    return crypto.subtle.importKey(
      'pkcs8',
      binaryDerArray,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      true,
      ['sign'],
    );
  } catch {
    throw new Error('Failed to decode private key PEM base64 content');
  }
}
