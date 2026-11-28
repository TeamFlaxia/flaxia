# ActivityPub Federation

Flaxia federates with other ActivityPub services (Mastodon, GoToSocial, Misskey, …).
This document is the specification of the implementation: what the instance
publishes, what it accepts and how it is tested.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Remote      │────▶│  /api/inbox      │────▶│  Queue       │
│  Instance    │     │  (SvelteKit API) │     │  Consumer    │
└──────────────┘     └──────────────────┘     └──────────────┘
                                                        │
                                                        ▼
                                              functions/lib/activitypub/handlers.ts
                                              (store the activity)
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Remote      │◀────│  Queue Delivery  │◀────│  functions/  │
│  Instance    │     │  (Queue Worker)  │     │  api/routes/ │
└──────────────┘     └──────────────────┘     └──────────────┘
```

### Modules (`functions/lib/activitypub/`)

| Module | Responsibility |
|---|---|
| `context.ts` | JSON-LD contexts, media types, content negotiation |
| `text.ts` | Remote HTML → plain text, plain text → HTML, hashtags, mentions |
| `actor.ts` | Actor URLs, actor document, WebFinger resources, local actor lookup |
| `note.ts` | Note objects, audience mapping (`to`/`cc`) |
| `activities.ts` | Builders for every activity the instance sends |
| `signature.ts` | HTTP Signatures: parsing, signing, verification (no network) |
| `fetch.ts` | Network access: SSRF guard, actor documents, key resolution |
| `webfinger.ts` | WebFinger discovery document |
| `inbox.ts` | The verification pipeline of both inbox endpoints |
| `handlers.ts` | Processing of the received activities |
| `delivery.ts` | Delivery: one message per remote inbox |
| `attachments.ts` | Incoming attachment URLs → `post_attachments` |
| `authors.ts` | Decorate stored remote posts with their actor profile |
| `keys.ts` | Per-account signing key creation and lookup |
| `crypto.ts` | PEM import/export, RSA key generation |

The route handlers (`functions/api/routes/activitypub.ts`) only map paths to
modules; the queue worker (`functions/queue-worker.ts`) only decides what to do
with a message.

## Endpoints

All paths below are served under `/api`. The root discovery documents
(`/.well-known/webfinger`, `/.well-known/nodeinfo`, `/host-meta`) are served by
SvelteKit `+server.ts` routes that bridge the modules in `functions/`. Most
parameterised legacy paths (`/actors/…`, `/notes/…`) redirect to `/api/…`, see
`src/hooks.server.ts`; legacy inbox paths (`/users/…/inbox`, `/actors/…/inbox`)
are handled directly instead of redirected, so the signed request target is not
changed by a redirect.

| Endpoint | Purpose |
|---|---|
| `GET /api/.well-known/webfinger?resource=…` | Discovery of an account (`acct:` and profile URL) |
| `GET /api/host-meta` | LRDD host meta, points at the WebFinger endpoint |
| `GET /api/.well-known/nodeinfo` | NodeInfo discovery document |
| `GET /api/nodeinfo/2.1` | NodeInfo document of the instance |
| `GET /api/actors/:username` | Actor document (Person) |
| `GET /api/actors/:username/followers` | Ordered collection of the followers |
| `GET /api/actors/:username/following` | Ordered collection of the followed accounts |
| `GET /api/actors/:username/liked` | Ordered collection of the liked notes |
| `GET /api/actors/:username/featured` | Ordered collection (empty) |
| `GET /api/actors/:username/outbox` | Ordered collection of the published activities |
| `GET /api/notes/:noteId` | The Note of a post |
| `POST /api/actors/:username/inbox` | Personal inbox of an actor |
| `POST /api/inbox` | Shared inbox of the instance |

The actor document publishes the collections, the shared inbox, the key and
the flags a peer needs (`manuallyApprovesFollowers`, `discoverable`,
`indexable`).

## Supported activities

| Activity | Direction | Notes |
|---|---|---|
| `Create` (Note) | Both | A post of an account the user follows is stored with the remote author |
| `Follow` | Both | The `Accept` is queued, not delivered inline |
| `Accept` | Inbound | Marks a remote follow as accepted |
| `Reject` | Inbound | Marks a remote follow as rejected |
| `Like` | Both | Flaxia's "fresh" is the like |
| `Announce` | Both | Flaxia's "reload" is the boost |
| `Undo` | Both | Follow, Like, Announce and Block; the retracted target may also be named on the Undo's `to`/`cc` audience (as Flaxia's own Undo does) |
| `Delete` | Both | Deletes a note or a remote actor; the object may be a bare string URL or an object with `id` (`Person`/`Tombstone`) |
| `Update` | Inbound | Refreshes the cached profile of a remote actor |
| `Block` | Inbound | Records a blocked remote actor |
| `Move` | Inbound | Remembers that a remote actor moved; the new actor URL comes from `target` (Mastodon) or `movedTo`, as a string on the signing actor's origin |

An activity is only ever applied for the actor that signed it. An `Undo` that
refers to another actor is ignored, and only the author of a note may delete
it.

## Audience

| Visibility | `to` | `cc` |
|---|---|---|
| `public` | `…#Public` | followers, mentions |
| `unlisted` | followers, mentions | `…#Public` |
| `private` | followers, mentions | – |
| `direct` | mentions | – |

Mentions are published as `tag` entries (`Mention`), hashtags as `tag` entries
(`Hashtag`).

For inbound activities the mapping is reversed: `visibilityFromInboundAudience()`
in `handlers.ts` reads `to`/`cc` from both the activity and the Note, accepts the
Public collection along with its aliases, and recognises a followers collection
only when it belongs to the signing actor. An absent audience keeps the
historical `public` default; a recipient named only in `bto`/`bcc`/`audience`
becomes `direct`.

## Authentication & Security

### HTTP Signatures

* Draft Cavage (`draft-cavage-http-signatures-12`) and RFC 9421
  (`Signature-Input` + `Signature`, including `Content-Digest` / RFC 9530),
  both RSA-SHA256. RFC 9421 is tried first when advertised; the draft path
  remains available for older peers (including Mastodon double-knocking).
* A draft signature has to cover `(request-target)`, `date` and – for a
  request with a body – `digest`. An RFC 9421 signature has to cover a target
  component (`@target-uri`, `@request-target` or `@path`) and, for a request
  with a body, `content-digest` or `digest`.
* The key is resolved from the `keyId` / `keyid` of the signature and only from
  the origin of the actor: a key hosted somewhere else never vouches for an
  actor.
* The `created` and `expires` parameters are honoured; `created` is bounded in
  both directions so it can replace `Date` as the freshness signal.
* A signature that does not cover the host is only accepted for the host the
  actor lives on.

### Other guards

* The body of an inbox delivery is limited to 256 KiB.
* The inbox is rate limited per client address.
* An exact replay of a delivery is dropped (fingerprint of signature, date
  and digest).
* Every activity is claimed once, so a retried delivery is not applied twice.
* Every request to a remote instance goes through the SSRF guard: only public
  http(s) targets, every redirect hop is validated again.

### Private peers

`AP_ALLOWED_PRIVATE_PEERS` allows the federation to talk to a peer that runs
next to the instance (a container on the same machine). The variable is only
honoured when `ENVIRONMENT` is `test` or `development`; in production it has
no effect at all.

### Queue-less development delivery

`AP_DIRECT_DELIVERY=1` delivers and processes activities inside the request
because the local dev server has no queue consumer. It uses the **same
environment gate** as `AP_ALLOWED_PRIVATE_PEERS`: outside `test` and
`development` the binding is ignored. This matters because direct delivery
skips the queue worker's second `parsePublicHttpUrl()` check. `npm run
dev:federation` sets both bindings; production configuration sets neither.

## Database tables

| Table | Content |
|---|---|
| `actor_keys` | The key pair of a local actor |
| `ap_actors` | Cached actor documents of remote instances |
| `ap_followers` | Remote followers of a local account |
| `ap_following` | Remote accounts a local account follows |
| `ap_blocks` | Blocked remote actors |
| `ap_activities` | Activities that were already processed (idempotency) |
| `posts.ap_object_id` | The ActivityPub object id of a received post |

## Remote posts and authors

A remote Note is stored once per instance, not once per local recipient. The
row uses `posts.user_id = ''` because no local account owns the content; the
author is `posts.actor_id`. This keeps remote posts out of local profiles and
prevents a local recipient from editing or deleting them.

`ap_object_id` has a unique partial index, so a Note delivered to several
local followers is inserted only once. The feed API fills the author fields
from `ap_actors` after the rows are fetched (`display_name`, `avatar_url`,
`profile_path`, `is_remote`). The client renders the remote handle as
`@user@domain` and links it to `/@domain/user`.

## For You is local-only

For You returns Flaxia posts only. Federated (Mastodon and other instances)
posts are excluded on both paths:

* both server paths (`GET /api/posts/recommended`, including `client_rank=1`)
  exclude federated rows at query time, before scoring, so remote posts cannot
  consume candidate slots or block the archive fallback;
* `presentForYou()` applies the same local-only filter to the response, and the
  Svelte timeline applies it again after personal re-ranking.

The shared rule lives in `shared/recommendation/mix.ts`. Federated posts belong
to the Federated tab, not to recommendations.

The unmerged `feat/activitypub-outbox-recommendations` branch was **discarded**:
its 1:1 interleave is gone and federated posts no longer appear in For You at
all. The source described below is a separate, popularity-based pool — not a
revival of that branch.

## Federated popularity pool

A Mastodon instance does not push posts to accounts it is not followed by. To
show federation content without following every actor, Flaxia **pulls popular
public posts** and stores them once in `posts` (with `actor_id`, no local owner).

* Discovery runs hourly (`5 * * * *` in `wrangler.worker.toml`) via
  `functions/lib/activitypub/ap-pool.ts`. Known actor domains from `ap_actors`
  plus a seed list of English- and Japanese-speaking instances (`mstdn.jp`,
  `mastodon.jp`, `mstdn.plus`, ...) are probed through
  `fetchFederationDocument()` (SSRF guard, redirect re-validation). Mastodon
  instances contribute `/api/v1/trends/statuses` and tag timelines for hashtags
  popular on Flaxia; with the default `ja` preference, fixed Japanese tag seeds
  are interleaved with those local trends and their statuses are filtered by
  the Mastodon `language` field (the tag endpoint itself has no language
  parameter). Other implementations fall back to the actor's public Outbox.
  `AP_POOL_SEED_DOMAINS` and `AP_POOL_PREFERRED_LANGUAGE` override the defaults.
* Only public Notes are stored: the author must match the signed actor, the
  object id must live on the same origin, text is capped at 200 characters and
  unsafe HTML is discarded. `unlisted` and private Notes are rejected because
  this is public discovery. Numeric Mastodon ids are resolved to the same AP
  object id used by inbox delivery, so a Note appears once and a received
  `Delete` hides every copy. Blocked actors, sensitive posts and timestamps
  more than ten minutes in the future are skipped.
* Popularity is recorded in `ap_pool_metrics` with a composite score of
  favourites (likes), reposts and freshness (`freshnessBoost()` from
  `functions/lib/scoring.ts`). Flaxia-only reaction counters are not exposed by
  Mastodon REST, so they are not part of this score. The score and counters are recomputed on every
  hourly discovery, so the freshness term decays. Per-instance and per-actor
  caps prevent one instance from taking over. Only pool-origin rows (marked by
  an `ap_pool_metrics` row) older than 7 days are pruned; Notes received from
  followed actors and their replies are never removed by the pool.
* Mastodon's `status.language` is stored in `ap_pool_language` (migration 0155).
  The **Federated** tab (`/federated`, `GET /api/federated/posts`) lists the pool
  by score, not chronologically, and is readable by guests. A post in the
  viewer's language — account setting, locale cookie or `Accept-Language` —
  receives a small ranking boost. For signed-in viewers, a post seen in the
  last 24 hours is hidden and an older impression damps its rank; this
  "seen once" rule is limited to the Federated tab. For You never includes
  federated posts.
* A received `Delete` hides the pooled post through the existing inbox handler;
  user blocks apply to the Federated tab as well.

## Tests

| Layer | Location | Needs |
|---|---|---|
| Unit | `tests/activitypub-{note,signature,inbox,inbox-handlers,delivery}.test.ts` | nothing |
| Integration | `tests/activitypub-discovery.test.ts` | `npm run dev:test` |
| Guards | `tests/activitypub-inbox-integrity.test.ts`, `tests/activitypub-delivery-guard.test.ts`, `tests/security-guards.test.ts` | nothing |

```bash
npm run test:group -- activitypub
```

The unit tests run against a real SQLite database that is built from the real
D1 migrations (`tests/helpers/d1.ts`), so a query that does not match the
production schema fails there as well.

The differential test against a real instance (GoToSocial, Mastodon) lives in
`tests/federation/` and is described in `docs/federation-testing.md`.
