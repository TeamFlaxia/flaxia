# ActivityPub Federation

## Overview

Flaxia implements ActivityPub for federation with other ActivityPub-compatible services (Mastodon, Misskey, etc.).

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Remote      │────▶│  /api/inbox      │────▶│  Queue       │
│  Instance    │     │  (Pages Function)│     │  Consumer    │
└──────────────┘     └──────────────────┘     └──────────────┘
                                                        │
                                                        ▼
                                                 Process Activity
                                                 (Store/Forward)
                                                        │
                                                        ▼
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Remote      │◀────│  Outbox Delivery  │◀────│  Queue Producer  │
│  Instance    │     │  (Worker)         │     │  (Pages Function)│
└──────────────┘     └──────────────────┘     └──────────────────┘
```

## Key Components

### `functions/lib/activitypub/`
- `crypto.ts` — HTTP Signature verification and signing
- `note.ts` — ActivityPub Note object creation
- `signature.ts` — HTTP Signature utilities

### `functions/queue-worker.ts`
Queue consumer (deployed as separate Worker `flaxia-backend`):
- Processes incoming activities from the queue
- Delivers outgoing activities to remote inboxes

### Bindings
- `AP_DELIVERY_QUEUE` — Queue for outbound delivery (`wrangler.toml`)
- `BACKEND` — Service binding to `flaxia-backend` Worker (`wrangler.toml`)

## Endpoints

### WebFinger
`GET /.well-known/webfinger?resource=acct:user@domain`
- Returns actor URL and profile page
- Standard WebFinger response format

### NodeInfo
`GET /.well-known/nodeinfo`
- Returns NodeInfo 2.1 link
- Software: `flaxia`, version: current

### Actor
`GET /api/actors/:username`
- Returns ActivityPub Actor object (Person)
- Includes: id, inbox, outbox, followers, following, publicKey
- URLs are under the main domain

### Inbox
`POST /api/inbox`
- Receives activities from remote instances
- Content-Type: `application/activity+json`
- Validates HTTP Signature before processing
- Enqueues processing via Cloudflare Queue

### Outbox
`GET /api/actors/:username/outbox`
- Returns public posts (ordered by `created_at` desc)
- Paginated

## Supported Activities

| Activity | Direction | Description |
|---|---|---|
| `Create` (Note) | Inbound | Remote user posts |
| `Follow` | Both | Follow request |
| `Accept` (Follow) | Outbound | Accept follow |
| `Like` | Both | Like a post |
| `Announce` | Both | Share/boost a post |
| `Undo` | Both | Undo Follow/Like/Announce |
| `Delete` | Inbound | Delete remote post/actor |

## Authentication & Security

### HTTP Signatures
- All outgoing requests are signed using the actor's RSA key pair
- Incoming requests are verified against the actor's public key (fetched via WebFinger)
- Signatures use `Signature` header or `Digest` + `Signature` headers

### Key Management
- RSA key pairs stored in `ap_actor_keys` table
- Generated on user registration
- Public key exposed via Actor endpoint

## Database Tables

- `ap_actor_keys` — Local user key pairs
- `ap_followers` — Remote followers (actor_url, inbox_url, status)
- `ap_liked` — Remote likes on local posts
- `ap_shares` — Remote shares on local posts

## Queue Consumer (`flaxia-backend`)

The backend Worker (`functions/queue-worker.ts`) handles:
1. Processing incoming activities from the queue
2. Delivering outgoing activities to remote inboxes
3. Retry logic for failed deliveries

Deployment:
```bash
npx wrangler deploy functions/queue-worker.ts \
  --config wrangler.toml.worker \
  --name flaxia-ap-delivery
```
