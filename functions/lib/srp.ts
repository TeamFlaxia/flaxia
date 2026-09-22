// SRP-6a (RFC 5054 style) using the 2048-bit group and SHA-256.
// Pure implementation: only BigInt + Web Crypto (crypto.subtle).
// The server never receives the password; it only stores the verifier v.
//
//   x = KDF(password, salt)             (client computes at registration)
//   v = g^x mod N                       (client computes at registration)
//   A = g^a mod N                       (client ephemeral)
//   B = (k*v + g^b) mod N               (server ephemeral)
//   u = H(PAD(A) | PAD(B))
//   S_client = (B - k*g^x)^(a + u*x) mod N
//   S_server = (A * v^u)^b mod N
//   K = H(S);  M1 = H(A | B | K);  M2 = H(A | M1 | K)

const N = BigInt(
  '0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC319294' +
    '3DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D' +
    'CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FB' +
    'D5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74' +
    '7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A' +
    '436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D' +
    '5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E73' +
    '03CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6' +
    '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F' +
    '9E4AFF73',
);
const G = 2n;
const N_BYTES = 256;
// k = H(PAD(N) | PAD(g)) with SHA-256 (precomputed).
const K_MULT = BigInt('0x5b9e8ef059c6b32ea59fc1d322d37f04aa30bae5aa9003b8321e21ddb04e300');
const subtle = (globalThis.crypto as Crypto).subtle;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(digest);
}

// ─── KDF for the private value x ─────────────────────────────────────────────
//
// `v = g^x` is stored server-side, so anyone holding a database dump can
// dictionary-attack x offline. How expensive that attack is depends entirely on
// how x was derived — which only the client ever computes (the server only ever
// compares v), so strengthening it costs the server nothing.
//
//   sha256-v1        x = SHA-256(salt | password)          1 hash per guess
//   pbkdf2-600k-v2   x = PBKDF2-SHA256(password, salt, 600_000)
//
// v1 is kept only so verifiers created before this scheme still authenticate;
// every new or re-derived verifier uses v2. The id travels with the account
// (`users.srp_kdf`) and is handed to the client by /login/start and
// /reauth/start, so the client always derives x the same way the stored v was
// built. New ids may be added later (e.g. an Argon2id variant) without a flag
// day: the id IS the version.
export type SrpKdfId = 'sha256-v1' | 'pbkdf2-600k-v2';

export const SRP_KDF_V1: SrpKdfId = 'sha256-v1';
export const SRP_KDF_V2: SrpKdfId = 'pbkdf2-600k-v2';
export const DEFAULT_SRP_KDF: SrpKdfId = SRP_KDF_V2;

const SRP_KDF_ITERATIONS_V2 = 600_000;

// Exact-match allowlist: an unknown id from a client is rejected rather than
// passed through, so a client cannot register an account with a cheap KDF.
export function isSupportedSrpKdf(value: unknown): value is SrpKdfId {
  return value === SRP_KDF_V1 || value === SRP_KDF_V2;
}

async function deriveX(password: string, salt: Uint8Array, kdf: SrpKdfId): Promise<Uint8Array> {
  if (kdf === SRP_KDF_V1) {
    return sha256(concat(salt, new TextEncoder().encode(password)));
  }
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: SRP_KDF_ITERATIONS_V2, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function bigIntToBytes(b: bigint, len = N_BYTES): Uint8Array {
  const hex = b.toString(16).padStart(len * 2, '0');
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function pad(b: bigint): Uint8Array {
  return bigIntToBytes(b, N_BYTES);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  let e = exp < 0n ? -exp : exp;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    e >>= 1n;
  }
  return result;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  (globalThis.crypto as Crypto).getRandomValues(b);
  return b;
}

function randomScalar(): bigint {
  const r = bytesToBigInt(randomBytes(32));
  return (r % (N - 2n)) + 1n;
}

export interface SrpClientStart {
  A: Uint8Array;
  a: bigint;
}
export interface SrpClientFinish {
  M1: Uint8Array;
  K: Uint8Array;
  A: Uint8Array;
}

export function generateSalt(): Uint8Array {
  return randomBytes(16);
}

export async function computeVerifier(
  password: string,
  salt: Uint8Array,
  kdf: SrpKdfId = DEFAULT_SRP_KDF,
): Promise<Uint8Array> {
  const x = bytesToBigInt(await deriveX(password, salt, kdf));
  const v = modPow(G, x, N);
  return bigIntToBytes(v, N_BYTES);
}

export async function clientStep1(password: string, salt: Uint8Array): Promise<SrpClientStart> {
  const a = randomScalar();
  const A = modPow(G, a, N);
  return { A: bigIntToBytes(A, N_BYTES), a };
}

export async function clientStep2(
  password: string,
  salt: Uint8Array,
  a: bigint,
  B: Uint8Array,
  kdf: SrpKdfId = DEFAULT_SRP_KDF,
): Promise<SrpClientFinish> {
  const B_bi = bytesToBigInt(B);
  if (B_bi % N === 0n) throw new Error('SRP: invalid server public');
  const A_bi = modPow(G, a, N);
  const u = bytesToBigInt(await sha256(concat(pad(A_bi), pad(B_bi))));
  // Must use the same KDF the stored verifier was built with; /login/start and
  // /reauth/start report `srp_kdf` for exactly this reason.
  const x = bytesToBigInt(await deriveX(password, salt, kdf));
  const base = (((B_bi - K_MULT * modPow(G, x, N)) % N) + N) % N;
  const exp = (a + u * x) % N;
  const S = modPow(base, exp, N);
  const K = await sha256(bigIntToBytes(S, N_BYTES));
  const M1 = await sha256(concat(bigIntToBytes(A_bi, N_BYTES), B, K));
  return { M1, K, A: bigIntToBytes(A_bi, N_BYTES) };
}

export async function verifyServerProof(
  A: Uint8Array,
  M1: Uint8Array,
  K: Uint8Array,
  M2: Uint8Array,
): Promise<boolean> {
  const expected = await sha256(concat(A, M1, K));
  return constantTimeEqual(expected, M2);
}

export async function serverStep1(salt: Uint8Array, v: Uint8Array): Promise<{ B: Uint8Array; b: bigint }> {
  const b = randomScalar();
  const v_bi = bytesToBigInt(v);
  const B = (K_MULT * v_bi + modPow(G, b, N)) % N;
  return { B: bigIntToBytes(B, N_BYTES), b };
}

export async function serverStep2(
  A: Uint8Array,
  B: Uint8Array,
  b: bigint,
  v: Uint8Array,
  M1: Uint8Array,
): Promise<{ M2: Uint8Array; K: Uint8Array } | null> {
  const A_bi = bytesToBigInt(A);
  if (A_bi % N === 0n) return null;
  const B_bi = bytesToBigInt(B);
  const v_bi = bytesToBigInt(v);
  const u = bytesToBigInt(await sha256(concat(pad(A_bi), pad(B_bi))));
  const S = modPow((A_bi * modPow(v_bi, u, N)) % N, b, N);
  const K = await sha256(bigIntToBytes(S, N_BYTES));
  const M1_expected = await sha256(concat(A, bigIntToBytes(B_bi, N_BYTES), K));
  if (!constantTimeEqual(M1_expected, M1)) return null;
  const M2 = await sha256(concat(A, M1, K));
  return { M2, K };
}
