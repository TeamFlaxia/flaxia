# End-to-End Encryption (Personal Vault)

## Purpose

Protect **personal data stored on the server** — drafts, private notes, and
personal settings — so that a database dump, a curious operator, or a stolen
backup does not expose what the user wrote.

Posts and media are **deliberately out of scope**: they are public by design,
federate over ActivityPub, must be indexable by the SSR/vector pipelines, and
must arrive in cleartext to push notifications. Encrypting them would break
the product while protecting nothing that was not already public.

This document is the specification. Code that contradicts it is a bug.

---

## Threat model

| # | Adversary | In scope? | Mitigation |
|---|---|---|---|
| T1 | Someone with a full D1 dump / R2 bucket / backup | ✅ | Only ciphertext and wrapped keys at rest |
| T2 | A passive network observer | ✅ | TLS + no plaintext secrets in requests |
| T3 | An attacker replaying captured API traffic | ✅ | Single-use SRP proofs, session cookies, nonce/IV uniqueness |
| T4 | A stolen/lost **device** | ✅ | Device approval (QR), per-device revocation |
| T5 | The operator reading user data | ✅ | The server never holds a key that can decrypt vault payloads |
| T6 | A compromised Worker / malicious deploy | ⚠️ partial | Server still never stores KEK/VK/`item_key`, but a hostile build can exfiltrate plaintext **as the user unlocks it** |
| T7 | XSS in the main origin | ❌ out of band | CSP + sandboxing; E2EE does not survive same-origin script execution |
| T8 | A user who forgets their password | ✅ | Recovery phrase (the only escape hatch) |
| T9 | Coercion / legal compulsion of the user | ❌ | Out of scope |

**Honest limit (T6):** the browser sends plaintext vault content to be stored
after decrypting it locally. A server that serves modified JavaScript can read
it during that session. E2EE here protects *stored data and backups*, not
against a hostile live build. That is stated openly rather than implied away.

---

## Key hierarchy

All cryptographic operations run **client-side**. The server stores opaque
byte strings and never derives, unwraps, or validates key material.

```
password ──PBKDF2-SHA256(600k, salt)──► KEK ─┐
recovery phrase ──PBKDF2-SHA256(600k, salt_r)──► REK ─┤─wrap─► VK (vault key, random 32 B)
device key D (non-extractable CryptoKey, IndexedDB) ─┘
                                                              │
                                                              └─wrap─► item_key[i] (random 32 B)
                                                                            │
                                                                            └─AES-GCM─► payload[i]
```

- **KEK** — derived from the password. Never stored, never sent.
- **REK** — derived from the BIP-39 recovery phrase. Independent of the
  password, so a password change does not invalidate recovery.
- **D** — per-device, generated locally, marked `extractable: false` so page
  script cannot read it out of IndexedDB. It only ever wraps/unwraps.
- **VK** — the vault root. Wrapped under KEK, REK, and each approved device's
  D. This is what makes the scheme *stateless envelope*: every unlock path
  converges on VK without a ratchet state.
- **item_key[i]** — one per vault item, wrapped by VK. Enables rotation
  without touching ciphertext.
- **payload[i]** — the item body, AES-256-GCM under `item_key[i]`.

### Why two layers under VK

Rotating VK must invalidate every device that still holds the old one (device
revocation). If payloads were encrypted directly under VK, revocation would
require re-encrypting every body. With `item_key` in between, revocation
re-wraps `item_key` rows only — bodies are never rewritten. Past incidents in
this repo (migrations `0076`, `0078`, `0081`) all trace back to key/state
handling that was rewritten in place; this layout makes the expensive,
error-prone operation unnecessary.

---

## Storage (D1)

```sql
vault_keys(user_id PK, salt,                                  -- password path (KEK)
           recovery_salt,                                     -- recovery path (REK)
           kdf_params, wrapped_vk, recovery_blob,
           vk_version, created_at, updated_at)
device_keys(id PK, user_id, label, state,                    -- pending → active
           peer_pub, approved_pub, wrapped_vk,               -- QR handshake
           created_at, expires_at, last_seen_at)
vault_items(user_id+id PK, item_key_wrapped, payload,         -- AES-GCM output
            kind, vk_version, created_at, updated_at)
```

Migrations `0091_add_vault.sql` (tables) and `0092_pairing_devices.sql`
(pairing columns).

- `salt` and `recovery_salt` are independent, so a user who picks their
  password as their recovery phrase still gets two separate paths rather than
  one duplicated envelope.
- `kdf_params` (JSON) travels with the row so the KDF can be strengthened later
  without a flag day: the parameters that produced the stored `wrapped_vk` are
  the parameters the client must use to reopen it. The server allowlists the
  shape (`isValidVaultKdfParams`) but never runs it.
- `wrapped_vk` / `recovery_blob` / `item_key_wrapped` / `payload` each carry
  their own IV in the canonical `base64(iv).base64(ct)` form.
  **IVs must never be reused with the same key** (migration `0076` exists
  because they once were).
- `vk_version` increments on rotation; it is the id used to detect a client
  holding a stale VK. `PUT /api/vault/keys` rejects a mismatched
  `vk_version` instead of overwriting what it cannot reproduce.
- `vault_items.id` is generated by the client and is the AAD of both crypto
  layers, so a payload cannot be moved to another row.
- `device_keys` rows hold **public** ephemeral keys plus one handoff blob. The
  blob is wrapped under an X25519 shared secret whose two private halves are
  discarded the moment pairing finishes, so afterwards the row is inert — it is
  kept only as a revocation record, and a database dump of it opens nothing.
  The device that *enables* the vault registers itself in the same request
  under a client-chosen id (no pairing, empty fields): without that first row
  there would be no record to revoke for the first device, which is exactly
  the case threat T4 cares about.

---

## API

| Endpoint | Purpose | Proof |
|---|---|---|
| `GET /api/vault/keys` | Fetch the envelope + device list to unlock | session |
| `POST /api/vault/keys` | Enable the vault (409 if one exists); optional `device_id`/`device_label` self-registers the enabling device | `current_srp` |
| `PUT /api/vault/keys` | Rotate the whole envelope (bumps `vk_version`) | `current_srp` + `vk_version` |
| `PATCH /users/me/password` | Swap verifier **and** re-wrap VK atomically | `current_srp` + `vault_kek` |
| `POST /api/vault/devices` | Start a pairing → `{ id, expires_at }` (`ttl_seconds` 1–600) | session |
| `GET /api/vault/devices` | List devices — ids, labels, states; never blobs | session |
| `GET /api/vault/devices/:id` | Joiner poll: `pending` → `active` or `expired` | session |
| `POST /api/vault/devices/:id/approve` | Hand VK to the joiner (409 reused, 410 expired) | session + QR |
| `DELETE /api/vault/devices/:id` | Revoke a device | session |

If an account has `vault_keys` and the password change omits `vault_kek`, the
request fails with **409 `vault_rewrap_required`** — an envelope left wrapped
around the old password would be unreachable afterwards. If no vault exists,
sending `vault_kek` fails with 400 rather than silently creating rows.

### Pairing a second device

1. The joiner (new device) generates an **ephemeral** X25519 keypair and
   `POST /api/vault/devices` with its public half → `{ id }`.
2. It displays `flaxia-vault://pair/<id>#<base64(peer_pub)>` as a QR code and
   polls `GET /api/vault/devices/<id>` until the state leaves `pending`.
3. An already-unlocked device scans that QR, derives
   `HKDF-SHA256(X25519(approver, joiner), info = "flaxia.vault.pair.v1:<id>")`,
   wraps VK under it, and `POST`s `{ approved_pub, wrapped_vk }`.
4. The joiner opens the blob with its own secret, stores VK under its
   non-extractable device key (IndexedDB), and **both ephemeral private keys
   are discarded** — so the stored blob can never be opened again, by anyone.

The pairing id is mixed into both the KDF info and the AAD, so a blob cannot be
replayed into another pairing session. Approving needs only a session because
the scan is the second factor: the code is displayed on the very device being
added, so a stolen session can neither read VK nor complete a pairing without
physical access to that screen. The recovery phrase remains the way back in
when a device is lost without ever being paired.

---

## Operations

| Operation | Client does | Server sees |
|---|---|---|
| Enable vault | Derives KEK, generates VK, generates REK from the phrase, wraps VK three ways | `salt`, `kdf_params`, `wrapped_vk`, `recovery_blob` + SRP proof |
| Register this device | Same request as enable; client picks the id so local record = server row | `device_id`, `device_label` |
| Unlock (reload) | Uses device key D to unwrap VK | nothing new |
| Unlock (new device) | Shows a QR (id + ephemeral public key); approver wraps VK under X25519+HKDF; joiner polls, opens it, discards both ephemerals | `label`, `peer_pub`, `approved_pub`, `wrapped_vk` — no secret |
| Unlock (password) | Derives KEK, unwraps VK | nothing |
| Recovery | Derives REK from phrase, unwraps VK, then re-establishes KEK/devices | nothing |
| Password change | Re-derives KEK, re-wraps **VK only** — atomically in the same `PATCH /users/me/password` | new `wrapped_vk` (opaque) |
| Device revoke | Generates a new VK, re-wraps every `item_key`, re-wraps own paths; other device rows deleted | n wrapped keys, no bodies |
| Account with vault, no re-wrap | **Rejected (409)** — the vault would be orphaned | — |

Vault enablement requires an **SRP account**: without a verifier there is no
way to prove the password, and the vault's threat model assumes the password
never reaches the server.

---

## Prohibitions

1. **The server must never receive** a password, KEK, REK, VK, `item_key`, or
   a recovery phrase — in any endpoint, including debug and test routes.
2. **No server-side escrow.** An earlier messenger implementation stored
   server-held keys and was deleted for it (`3bf1e18`). Do not reintroduce it.
3. **No `allow-same-origin` on iframes**, ever. Vault UI never renders inside
   the content sandbox.
4. **No plaintext password on the wire.** Registration, login, password
   change, email change and vault unlock all use SRP proofs. The legacy
   `POST /api/auth/login` exists only for pre-SRP accounts and is deleted when
   `GET /api/admin/auth-migration` reports `cutoff_reached`.
5. **No cryptographic primitives written ad hoc**: AES-GCM via WebCrypto,
   PBKDF2 via WebCrypto, X25519/HKDF via `@noble/*`, BIP-39 wordlists via
   `@scure/bip39`.
6. **No key/state updated in place without a version counter** (`vk_version`,
   `users.srp_kdf`). A client holding stale state must fail loudly, not
   silently decrypt the wrong thing.

---

## Authentication KDF (the vault's prerequisite)

The SRP verifier `v = g^x` commits to `x = KDF(password, salt)`, so a D1 dump
is dictionary-attacked offline. Only the client derives x (the server compares
v), so raising its cost is free server-side.

| id | derivation | status |
|---|---|---|
| `sha256-v1` | `SHA-256(salt ‖ password)` — 1 hash/guess | existing accounts, labelled by migration `0090` |
| `pbkdf2-600k-v2` | `PBKDF2-SHA256(password, salt, 600000)` | all new/re-derived verifiers |

The id is stored per user (`users.srp_kdf`), returned by `/login/start` and
`/reauth/start`, and validated as an **allowlist** — a client cannot register
an account with a cheap KDF. New ids (e.g. an Argon2id variant) can be added
without coordination because the id *is* the version.

Migration to v2 happens at every moment the browser legitimately holds the
password: legacy login (auto-upgrade), password change, and vault enable.

---

## Tests

| Suite | Covers |
|---|---|
| `tests/srp-kdf.test.ts` | v1/v2 handshakes, cross-version rejection, KDF allowlist |
| `tests/srp-copy.test.ts` | `src/lib/srp.ts` and `functions/lib/srp.ts` stay byte-identical |
| `tests/srp.test.ts`, `tests/srp-auth-e2e.test.ts` | protocol + server integration |
| `tests/password-policy.test.ts` | 8–128 rule now enforced client-side |
| `tests/vault-primitives.test.ts` | fixed test vectors for every vault primitive |
| `tests/vault-pairing.test.ts` | RFC 7748 / HKDF vectors, independent blob open, QR parsing |
| `tests/vault.test.ts`, `tests/vault-devices.test.ts` | envelope API + the full two-device handshake over HTTP |
| `tests/security-guards.test.ts` | static guards (escrow, sandboxing, constant-time verify) |
