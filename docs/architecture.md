# Architecture

## Overview

Flaxia uses a **two-origin model** to securely execute untrusted user content.

```
┌─────────────────────────────────────┐
│          flaxia.app                  │  Cloudflare Pages
│  ┌─────────────────────────────────┐│
│  │  SvelteKit SPA                   ││
│  │  ├── routes/* (+page.svelte)     ││
│  │  ├── src/lib/svelte/*            ││
│  │  └── legacy DOM behind .ts       ││
│  │      adapters (Arcade, PostText) ││
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
- ActivityPub: `actor_keys`, `ap_actors`, `ap_followers`, `ap_following`,
  `ap_blocks`, `ap_activities`

## ActivityPub Federation

- Discovery: `/.well-known/webfinger`, `/.well-known/nodeinfo`, `/host-meta`
- Actor endpoints and collections under `/api/actors/:username`
- Inbox/Delivery via Cloudflare Queues
- HTTP Signatures (src: `functions/lib/activitypub/signature.ts`)
- Supports: Follow, Accept, Reject, Like (Fresh), Announce (Share), Undo,
  Note (Create), Delete, Update, Block, Move
- The specification of the implementation is `docs/activitypub.md`

## SvelteKit SPA

The client is a SvelteKit 5 SPA (`@sveltejs/adapter-static`, `ssr = false`).
`src/routes/**/+page.svelte` owns route-level layout and session gates;
`src/lib/svelte/` contains the migrated surfaces. Remaining legacy DOM
factories live in `src/components/` and are only called from `.ts` adapters
(never directly from `.svelte`). `LEGACY_ADAPTERS.md` is currently empty and is
kept as a ratchet (`tests/legacy-adapters.test.ts`).

Routes:
- `/home` — Global / Following / For You feed (`Timeline.svelte`)
- `/posts/[id]` — thread detail (`ThreadPage.svelte`)
- `/profile/[username]`, `/users/[username]` — profiles
- `/arcade`, `/arcade/[id]` — game browser/player (`ArcadeView` + legacy engine adapter)
- `/search`, `/explore`, `/translate`, `/bookmarks`, `/notifications`
- `/settings`, `/mail/*`, `/admin/[tab]`
- `/docs/*`, `/download`, `/about`, `/privacy`, `/terms`, `/child-safety`

Navigation always uses `src/lib/navigation.ts` (`goto`), so SvelteKit keeps
`history.state` intact. Per-route titles live in `src/lib/page-title.ts`.

## Timeline and Recommendations

`src/lib/svelte/Timeline.svelte` selects the feed endpoint:

| Feed | Endpoint | Ordering |
|---|---|---|
| Global | `GET /api/posts` | Reverse chronological |
| Following | `GET /api/posts?following=true` | Reverse chronological, filtered to followed users |
| For You | `GET /api/posts/recommended` | Ranked recommendations |

Chronological feeds return `next_cursor` (the last post's `created_at`) so the
client can keep paging. `functions/api/routes/posts/feed.ts` implements them;
For You lives in `functions/api/routes/posts/recommendations.ts`. For You
combines following, trending, and recent candidates, then applies freshness,
engagement, trust, and recently-seen filters. Authors with a low trust score
(repeated near-duplicate posts) are excluded, and exact duplicates collapse to
their newest copy.

The explicit preference vector lives in the browser. With
`client_rank=1&include_vectors=1`, the API also returns public candidate
embeddings plus a server-computed `base_score`; the unlocked client blends
cosine similarity with its Vault-held vector (`src/lib/recommendation/`). The
server never stores or receives that vector. A locked/absent Vault falls back
to the server order.

Arcade recommendations live in `functions/api/routes/games.ts`
(`GET /api/games?recommended=true`) and use the same client-side ranking. See
[`docs/recommendation-rl.md`](recommendation-rl.md).

## Layout

```
┌─────────────┬──────────────────┬─────────────────┐
│  Left Nav   │   Main Feed      │   Right Panel   │
│  (240px)    │   (600px)        │   (350px)       │
└─────────────┴──────────────────┴─────────────────┘
```
- The shell is centred: `nav (240–350px) + centre (600px) + rail (350px)`.
- The right rail is hidden below 1200px and on surface pages
  (settings/mail/maps/arcade/translate/notifications).
- Mobile: Left Nav becomes a drawer, the bottom tab bar takes over, and the
  centre fills the viewport.
