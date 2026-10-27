const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateKeyOctetString = concatBytes(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const contents = concatBytes(version, RSA_ALGORITHM_IDENTIFIER, privateKeyOctetString);
  return concatBytes(Uint8Array.of(0x30), derLength(contents.length), contents);
}

function decodePrivateKey(pem: string): Uint8Array {
  const isPkcs8 = pem.includes('-----BEGIN PRIVATE KEY-----');
  const isPkcs1 = pem.includes('-----BEGIN RSA PRIVATE KEY-----');
  if (!isPkcs8 && !isPkcs1) throw new Error('Unsupported GitHub App private key format');

  const encoded = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');
  const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return isPkcs1 ? pkcs1ToPkcs8(decoded) : decoded;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Create the short-lived RS256 JWT required to authenticate as a GitHub App. */
export async function createGitHubAppJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error('Invalid GitHub App ID');

  const nowSeconds = Math.floor(now / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 8 * 60 })),
  );
  const signingInput = `${header}.${payload}`;
  const privateKey = decodePrivateKey(privateKeyPem);
  const privateKeyData = new ArrayBuffer(privateKey.length);
  new Uint8Array(privateKeyData).set(privateKey);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** Exchange the app JWT for a short-lived installation token. */
export async function createGitHubInstallationToken(
  appId: string,
  installationId: string,
  privateKeyPem: string,
): Promise<string> {
  if (!/^\d+$/.test(installationId)) throw new Error('Invalid GitHub App installation ID');

  const jwt = await createGitHubAppJwt(appId, privateKeyPem);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('GitHub App token request failed');

  const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (!body || typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('GitHub App token response was invalid');
  }
  return body.token;
}
