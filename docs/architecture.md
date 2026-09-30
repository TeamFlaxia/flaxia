# Architecture

## Overview

Flaxia uses a **two-origin model** to securely execute untrusted user content.

```
┌─────────────────────────────────────┐
│          flaxia.app                  │  Cloudflare Pages
│  ┌─────────────────────────────────┐│
│  │  SPA (Vanilla TypeScript)       ││
│  │  ├── Timeline / PostCard        ││
│  │  ├── PostComposer               ││
│  │  ├── ProfilePage / ThreadPage   ││
│  │  └── ArcadePage / AdminPage     ││
│  └──────────┬──────────────────────┘│
│             │ HTTP                  │
│  ┌──────────▼──────────────────────┐│
│  │  Hono API (Pages Functions)     ││
│  │  ├── POST /api/posts            ││
│  │  ├── GET /api/posts             ││
│  │  ├── Auth (sessions)            ││
│  │  ├── ActivityPub endpoints      ││
│  │  └── Admin endpoints            ││
│  └─────────────────────────────────┘│
└──────────────┬──────────────────────┘
               │ postMessage bridge
               │ (typed, origin-validated)
┌──────────────▼──────────────────────┐
│       sandbox.flaxia.app             │  Cloudflare Worker
│  ┌─────────────────────────────────┐│
│  │  Sandbox Worker (Hono)          ││
│  │  ├── Serves ZIP content via R2 ││
│  │  └── CSP enforcement           ││
│  └─────────────────────────────────┘│
│  ┌─────────────────────────────────┐│
│  │  Sandbox Iframe                 ││
│  │  ├── allow-scripts             ││
│  │  ├── allow-pointer-lock        ││
│  │  ├── NO allow-same-origin       ││
│  │  └── Blob URL content          ││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

## Two-Origin Model

| Origin | URL | Purpose | Tech |
|---|---|---|---|
| Main | `flaxia.app` | SNS UI, API, DB, storage | Cloudflare Pages + Hono |
| Sandbox | `sandbox.flaxia.app` | Execute untrusted content | Cloudflare Worker + Hono |

### Why two origins?
- **Security**: Untrusted user content (ZIP/SWF) never shares an origin with user sessions/cookies
- **Isolation**: `allow-same-origin` is permanently banned — no exception
- **CSP**: Sandbox origin enforces strict CSP via HTTP headers, not `<meta>` tags

## Cloudflare Bindings

| Binding | Type | Resource | Usage |
|---|---|---|---|
| `DB` | D1 database | `flaxia` | All persistent data |
| `BUCKET` | R2 bucket | `flaxia-content` | Post payloads, images, audio, avatars |
| `AP_DELIVERY_QUEUE` | Queue | `activitypub-delivery` | ActivityPub inbox delivery |

## postMessage Bridge

All cross-origin communication between main and sandbox uses a typed bridge (`src/lib/bridge.ts`).

### Parent → Sandbox
- `REQUEST_FULLSCREEN`
- `REQUEST_FRESH`
- `POST_SCORE`

### Sandbox → Parent
- `FULLSCREEN_GRANTED`
- `FULLSCREEN_DENIED`
- `FRESH_GRANTED`
- `FRESH_DENIED`
- `SCORE_SUBMITTED`
- `RUFFLE_READY`
- `RUFFLE_ERROR`

### Validation
- Origin check: `if (e.origin !== SANDBOX_ORIGIN) return`
- Type check: `score` must be `Number(score)` — reject if `NaN`

## Database (D1 / SQLite)

The schema evolves through the SQL migrations in [`migrations/`](../migrations/).
See that directory for the current migration history rather than relying on a
fixed file count. Major areas include:

- `posts` — Post content, text, payload keys, hashtags
- `users` — User profiles, sessions
- `follows` — Follower relationships
- `freshs` — Likes (called "Fresh")
- `shares`, `bookmarks`
- `notifications`
- `reports`, `ng_words`, `hidden_posts`
- `ads`, `ad_interactions`, `ad_config`
- `mentions`, `polls`, `post_thumbnails`
- ActivityPub: `ap_actor_keys`, `ap_followers`, `ap_liked`, `ap_shares`

## ActivityPub Federation

- Actor endpoints: `/.well-known/webfinger`, `/.well-known/nodeinfo`
- Inbox/Delivery via Cloudflare Queues
- HTTP Signatures (src: `functions/lib/activitypub/signature.ts`)
- Supports: Follow, Like (Fresh), Announce (Share), Undo, Note (Create)

## SPA Routing

The client-side SPA (`src/main.ts`) manages routing with the following views:
- **Timeline** — Global, Following, and For You feeds with ad injection
- **Thread** — Post detail with replies
- **Profile** — User profile with their posts
- **Arcade** — Browse playable game posts
- **Search** — Text/hashtag search
- **Bookmarks** — Bookmarked posts
- **Notifications** — Activity notifications
- **Admin** — Admin panel (alerts, hidden posts, users, ads)

## Timeline and Recommendations

The feed mode in `src/components/Timeline.ts` selects the API endpoint:

| Feed | Endpoint | Ordering |
|---|---|---|
| Global | `GET /api/posts` | Reverse chronological |
| Following | `GET /api/posts?following=true` | Reverse chronological, filtered to followed users |
| For You | `GET /api/posts/recommended` | Ranked recommendations |

`functions/api/routes/posts.ts` implements both chronological and recommended
post retrieval. Recommendations combine engagement and quality signals with
vector similarity when available. The shared interest-vector and LinUCB helpers
live in `functions/api/routes/recommender.ts` and `functions/lib/linucb.ts`.

Arcade recommendations are implemented separately in
`functions/api/routes/games.ts` (`GET /api/games?recommended=true`) and use
game-play dwell signals as well as personalization. See
[`docs/recommendation-rl.md`](recommendation-rl.md) for the recommendation model.

## Layout

```
┌─────────────┬──────────────────┬─────────────────┐
│  Left Nav   │   Main Feed      │   Right Panel   │
│  (240px)    │   (600px)        │   (350px)       │
└─────────────┴──────────────────┴─────────────────┘
```
- Mobile: Left Nav collapses to bottom tab bar, Right Panel hidden
