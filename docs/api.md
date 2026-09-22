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
- 409 if a vault already exists; 400 on malformed key material or a cheap KDF

### Rotate envelope
`PUT /api/vault/keys`
- Body: same as enable plus `vk_version` (the value currently stored)
- 409 on a stale `vk_version`; bumps the stored version on success

### Password change with a vault
`PATCH /api/users/me/password` must include `vault_kek: { salt, kdf_params,
wrapped_vk }`, re-wrapped under the new password in the same request.
Omitting it fails with **409 `vault_rewrap_required`**.

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
- Body: `{ contentType }`
- Returns: `{ postId, uploadUrl, uploadKey }`

### Upload File
`PUT /api/upload/:type/:postId`
- Binary upload directly to R2

### Commit Post
`POST /api/posts/commit`
- Body: `{ postId }`

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
