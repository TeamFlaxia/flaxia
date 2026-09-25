# API Reference

All API endpoints are served from `functions/api/[[route]].ts` via Hono framework.

---

## Authentication

SRP-6a end-to-end: the browser derives the verifier locally and the server
never sees a password (see `docs/e2ee.md`).

### Register
`POST /api/auth/register`
- Body: `{ email, username, display_name, srp: { salt, verifier, group, kdf } }`
- SRP verifier is **required** — a plaintext `password` field is rejected with 400
- Returns session cookie

### Login (SRP)
1. `POST /api/auth/login/start` — `{ email }` → `{ challenge_id, salt, B, srp }`
   - `srp: false` means a pre-SRP account; only then may the client fall back
2. `POST /api/auth/login/verify` — `{ challenge_id, A, M1 }` → session cookie
   - The client derives `M1` with the KDF id returned in step 1 (`srp_kdf`)

### Re-authentication proof
Used whenever an action needs proof that the *current password* is in hand
(password change, email change, vault enable/rotation). The password itself is
never sent.

1. `POST /api/auth/reauth/start` — no body (session cookie only) →
   `{ challenge_id, salt, B, srp_kdf }`
2. The client derives `A` and `M1` locally and sends `{ challenge_id, A, M1 }`
   as `current_srp` inside the sensitive request body. The endpoint that
   consumes it deletes the handshake, so a proof is single-use.

`POST /api/auth/reauth/verify` — `{ challenge_id, A, M1 }` → `{ valid }` is the
yes/no variant for callers that do not want to attach the proof to another
request. It never creates a session.

### Legacy login (deprecated)
`POST /api/auth/login` — `{ email, password }`
- Exists **only** for accounts created before SRP (`srp_salt IS NULL`)
- Deleted once `GET /api/admin/auth-migration` reports `cutoff_reached`

### Upgrade SRP
`POST /api/auth/upgrade-srp` — stores a verifier for a legacy account (called
automatically after a successful legacy login, or on password change)

### Logout
`POST /api/auth/logout`

### Me
`GET /api/auth/me`
- Returns current user info

---

## Personal Vault (E2EE)

Wrapped key material only — the server cannot decrypt anything here
(`docs/e2ee.md`).

### Get envelope
`GET /api/vault/keys`
- Returns `{ enabled: false }`, or `{ salt, recovery_salt, kdf_params,
  wrapped_vk, recovery_blob, vk_version, devices }`

### Enable
`POST /api/vault/keys`
- Body: `{ current_srp, salt, recovery_salt, kdf_params, wrapped_vk, recovery_blob }`
  plus optional `device_id` + `device_label` (16–40 base64url chars / 1–40 chars)
- `device_id` registers the *enabling* device as an active device row in the
  same atomic batch — the client picks the id so its local record and the
  server row are the same record (without it there would be nothing to revoke
  later). Malformed device fields → 400 **before** anything is written.
- 201 `{ enabled: true, vk_version, device_id }`; 409 if a vault already
  exists; 400 on malformed key material or KDF parameters outside the integer
  100 000–10 000 000 iteration window
  - Shape checks run **before** the proof, so a rejected body consumes no
    single-use handshake and writes nothing

### Rotate envelope
`PUT /api/vault/keys`
- Body: same as enable plus `vk_version` (the value currently stored);
  missing, fractional, or non-numeric `vk_version` → 400
- 409 on a stale `vk_version`; bumps the stored version on success
- The SRP proof is checked before the version conflict and is single-use:
  replaying an already-consumed proof → 401

### Password change with a vault
`PATCH /api/users/me/password` must include `vault_kek: { salt, kdf_params,
wrapped_vk }`, re-wrapped under the new password in the same request.
Omitting it fails with **409 `vault_rewrap_required`**.

### Pair a device (QR)
The joiner (new device) holds an ephemeral X25519 keypair; the approver is an
already-unlocked device. The server only relays public keys and one opaque
handoff blob — never the shared secret (see `docs/e2ee.md`).

1. `POST /api/vault/devices` — `{ label, peer_pub, ttl_seconds? }`
   → `{ id, expires_at }` (409 `vault_not_enabled`, 400 on bad shapes)
   - The joiner renders `flaxia-vault://pair/<id>#<peer_pub>` as its QR code
   - `ttl_seconds` is clamped to 1–600; default 600
2. `GET /api/vault/devices/<id>` — joiner polls:
   `{ state: 'pending' | 'active' | 'expired', ... }`; only `active` returns
   `{ approved_pub, wrapped_vk }`
3. `POST /api/vault/devices/<id>/approve` — `{ approved_pub, wrapped_vk }`
   - 409 `pairing_already_used`, 410 `pairing_expired`, 404 unknown id
   - Scanning the QR **is** the second factor, so no SRP proof is required
4. `GET /api/vault/devices` — management list (ids/labels/states, no blobs)
5. `DELETE /api/vault/devices/<id>` — revoke (404 if already gone)

---

## Posts

### Create Post
`POST /api/posts`
- Multipart: `text` (≤200 chars), optional `files` (image/audio/zip/swf)
- Returns: `{ post: Post }`

### Get Timeline
`GET /api/posts?cursor=<created_at>&limit=20`
- Returns posts from followed users
- Cursor-based pagination

### Get Post Thread
`GET /api/posts/:id`

### Delete Post
`DELETE /api/posts/:id`

### Like (Fresh)
`POST /api/posts/:id/fresh`

### Share
`POST /api/posts/:id/share`

### Bookmark
`POST /api/posts/:id/bookmark`
`DELETE /api/posts/:id/bookmark`

---

## Upload

### Prepare Upload
`POST /api/posts/prepare`
- Single legacy file: body `{ filename }` → `{ postId, gifUploadUrl?, gifKey?, zipUploadUrl?, zipKey?, swfUploadUrl?, swfKey? }`
- Multi-media attachments (up to 4 image/audio/video): body `{ files: [{ filename, contentType? }] }`
  → `{ postId, uploads: [{ key, uploadUrl, kind }] }`
- Game files (zip/swf/html/js/wasm) are rejected in the `files` list (400)

### Upload File
`PUT /api/upload/:key`
- Binary upload directly to R2 (requires auth; must own the pending/published post referenced by the key)

### Commit Post
`POST /api/posts/commit`
- Body: `{ postId, text, gifKey?, zipKey?, swfKey?, attachments?: [{ key, kind }] }`
- `attachments` is the full list (max 4, 25MB each / 50MB total); combining it
  with legacy game keys returns 422

### Add Attachment To Published Post
`POST /api/posts/:id/prepare-media`
- Body: `{ filename, contentType?, reservedKeys? }` — allocates the next free
  slot (max 4). `reservedKeys` is the caller's full planned list for the save:
  attachments it keeps plus keys already prepared in this session. Without it
  each call in the same edit session would be handed the same slot.
- Slots are taken from the position embedded in the R2 key, so a slot freed by
  a removal is reusable immediately.
- Returns: `{ uploadUrl, key, kind, position }`

### Edit Post
`PUT /api/posts/:id`
- Body: `{ text?, gif_key?, payload_key?, swf_key?, thumbnail_key?, attachments? }`
- `attachments` is a full replacement (`[]` clears all); 422 when it is not an
  array or when combined with legacy media keys
- Every edit reconciles NSFW screening: removed images drop their stored
  verdict, and new images are submitted for screening
- Returns `{ post }` including the enriched `attachments` list
- `quoted_post` on any post read is enriched with its own `attachments` list

---

## Users

### Get Profile
`GET /api/users/:username`

### Follow
`POST /api/follows/:userId`
`DELETE /api/follows/:userId`

### Followers / Following
`GET /api/users/:username/followers`
`GET /api/users/:username/following`

### Update Profile
`PATCH /api/users/me`

---

## Search

`GET /api/search?q=<query>&type=<posts|users|hashtags>`

---

## Notifications

`GET /api/notifications`

---

## Arcade (Game Posts)

`GET /api/games?cursor=&limit=`

---

## Advertisements

### Public
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/ads/active` | Active ads (randomized) |
| POST | `/api/ads/:id/impression` | Record impression |
| POST | `/api/ads/:id/click` | Record click |
| POST | `/api/ads/:id/interaction` | Record interaction duration |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/ads` | List all ads with stats |
| POST | `/api/admin/ads` | Create ad (multipart) |
| PATCH | `/api/admin/ads/:id` | Update ad |
| DELETE | `/api/admin/ads/:id` | Delete ad |
| GET | `/api/admin/ads/config` | Get ad config |
| PATCH | `/api/admin/ads/config` | Update ad config |

---

## ActivityPub

### WebFinger
`GET /.well-known/webfinger?resource=acct:user@domain`

### NodeInfo
`GET /.well-known/nodeinfo`
`GET /api/nodeinfo/2.1`

### Actor
`GET /api/actors/:username`

### Inbox (ActivityPub)
`POST /api/inbox`
- Receives federated activities (Follow, Like, Announce, Undo, Create)

### Outbox
`GET /api/actors/:username/outbox`

---

## Billing

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/billing/checkout` | Flaxia+ の Stripe Checkout セッション作成 |
| POST | `/api/billing/portal` | Stripe Customer Portal セッション作成 |
| GET | `/api/billing/plan` | Get current user's plan |
| GET | `/api/billing/transactions` | Get the user's payment history |
| POST | `/api/billing/webhook` | Stripe webhook receiver |

### Checkout
`POST /api/billing/checkout`
- Auth: Required (session cookie)
- Body: `{ planId: "flaxia_plus" }`
- Returns: `{ sessionId, url }` — redirect to Stripe Checkout
- Errors: `400` unsupported plan, `401` unauthorized, `409` already subscribed

### Portal
`POST /api/billing/portal`
- Auth: Required
- Returns: `{ url }` — Stripe Customer Portal (cancel / payment method / invoices)

### Get Plan
`GET /api/billing/plan`
- Auth: Optional
- Returns: `{ plan, planName, status, expiresAt, cancelAtPeriodEnd }`

### Get Transactions
`GET /api/billing/transactions`
- Auth: Required
- Returns: `{ transactions: [...] }` (latest 50)

---

## Marketplace

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/market/checkout` | Create Stripe Checkout session for content purchase |

### Market Checkout
`POST /api/market/checkout`
- Auth: Required (session cookie)
- Body: `{ postId: string, amount: number (100-50000), title?: string }`
- Returns: `{ sessionId, url }` — redirect to Stripe Checkout
- Note: Flaxia++ / Flaxia# subscribers get free access

---

## Admin

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/alerts` | List moderation alerts |
| POST | `/api/admin/alerts/:id/resolve` | Resolve alert |
| GET | `/api/admin/hidden-posts` | List hidden posts |
| POST | `/api/admin/hidden-posts` | Hide a post |
| DELETE | `/api/admin/hidden-posts/:id` | Unhide post |
| GET | `/api/admin/users` | List all users |
| PATCH | `/api/admin/users/:id` | Update user status |

---

## Misc

### Sitemap
`GET /sitemap.xml`

### Avatar
`GET /api/avatar/:userId`

### Link Preview
`POST /api/link-preview`
- Body: `{ url }`
- Returns: `{ title, description, image, url }`
