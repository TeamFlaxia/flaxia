/// <reference types="@cloudflare/workers-types" />

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

  console.log('PEM contents length:', pemContents.length);
  console.log('PEM contents (first 50 chars):', pemContents.substring(0, 50));
  console.log('PEM contents (last 50 chars):', pemContents.substring(pemContents.length - 50));

  // Validate base64 characters and clean
  const cleanedPem = pemContents.replace(/[^A-Za-z0-9+/=]/g, '');
  if (cleanedPem.length !== pemContents.length) {
    console.error('Invalid characters found and cleaned:', pemContents.length - cleanedPem.length);
    console.log('Original PEM length:', pemContents.length);
    console.log('Cleaned PEM length:', cleanedPem.length);
  }

  // Ensure proper padding
  let paddedPem = cleanedPem;
  while (paddedPem.length % 4 !== 0) {
    paddedPem += '=';
  }

  console.log('Final PEM length after padding:', paddedPem.length);

  // Decode base64 using Web Crypto API (Cloudflare Functions compatible)
  try {
    const binaryDerString = atob(paddedPem);
    const binaryDerArray = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) {
      binaryDerArray[i] = binaryDerString.charCodeAt(i);
    }
    console.log('Base64 decode successful, array length:', binaryDerArray.length);

    return crypto.subtle.importKey(
      'spki',
      binaryDerArray.buffer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      true,
      ['verify'],
    );
  } catch (error) {
    console.error('Base64 decode failed:', error);
    throw new Error('Failed to decode PEM base64 content');
  }
}

/**
 * Import private key from PEM format
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header and footer and clean all whitespace
  const pemHeader = '-----BEGIN PRIVATE KEY-----';
  const pemFooter = '-----END PRIVATE KEY-----';
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length).replace(/\s/g, ''); // Remove all whitespace including newlines and spaces

  console.log('Private key PEM contents length:', pemContents.length);
  console.log('Private key PEM contents (first 50 chars):', pemContents.substring(0, 50));

  // Validate base64 characters
  const invalidChars = pemContents.replace(/[^A-Za-z0-9+/=]/g, '');
  if (invalidChars.length !== pemContents.length) {
    console.error('Invalid characters found in private key PEM:', pemContents.length - invalidChars.length);
    throw new Error('Invalid base64 characters in private key PEM');
  }

  // Decode base64 using Web Crypto API (Cloudflare Functions compatible)
  try {
    const binaryDerString = atob(pemContents);
    const binaryDerArray = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) {
      binaryDerArray[i] = binaryDerString.charCodeAt(i);
    }
    console.log('Private key base64 decode successful, array length:', binaryDerArray.length);

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
  } catch (error) {
    console.error('Private key base64 decode failed:', error);
    throw new Error('Failed to decode private key PEM base64 content');
  }
}
