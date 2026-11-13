# ActivityPub Federation

Flaxia federates with other ActivityPub services (Mastodon, GoToSocial, Misskey, …).
This document is the specification of the implementation: what the instance
publishes, what it accepts and how it is tested.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Remote      │────▶│  /api/inbox      │────▶│  Queue       │
│  Instance    │     │  (Pages Function)│     │  Consumer    │
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

The route handlers (`functions/api/routes/activitypub.ts`) only map paths to
modules; the queue worker (`functions/queue-worker.ts`) only decides what to do
with a message.

## Endpoints

All paths below are served under `/api`. The canonical paths at the root
(`/…`) redirect to them, see `public/_redirects`.

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
| `Undo` | Both | Follow, Like, Announce and Block |
| `Delete` | Both | Deletes a note or a remote actor |
| `Update` | Inbound | Refreshes the cached profile of a remote actor |
| `Block` | Inbound | Records a blocked remote actor |
| `Move` | Inbound | Remembers that a remote actor moved |

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

## Authentication & Security

### HTTP Signatures

* Draft Cavage (`draft-cavage-http-signatures-12`), RSA-SHA256.
* The signature has to cover `(request-target)`, `date` and – for a request
  with a body – `digest`.
* The key is resolved from the `keyId` of the signature and only from the
  origin of the actor: a key hosted somewhere else never vouches for an actor.
* The `created` and `expires` parameters of the signature are honoured.
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

## Tests

| Layer | Location | Needs |
|---|---|---|
| Unit | `tests/activitypub-{note,signature,inbox,inbox-handlers,delivery}.test.ts` | nothing |
| Integration | `tests/activitypub-discovery.test.ts` | `npm run dev:test` |
| Guards | `tests/activitypub-inbox-integrity.test.ts`, `tests/security-guards.test.ts` | nothing |

```bash
npm run test:group -- activitypub
```

The unit tests run against a real SQLite database that is built from the real
D1 migrations (`tests/helpers/d1.ts`), so a query that does not match the
production schema fails there as well.

The differential test against a real instance (GoToSocial, Mastodon) lives in
`tests/federation/` and is described in `docs/federation-testing.md`.
