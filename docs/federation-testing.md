# Federationstest (差分照合)

The federation test compares the instance with another implementation of
ActivityPub. Both instances run on the same machine, follow each other,
exchange notes and the documents they publish are compared with each other.

The test found the differences that no unit test could find: a key that is
encoded in a way nothing else uses, a request without a user agent, an
instance in secure mode that answers nothing but a signed request.

## The peers

| Peer | Use | Needs |
|---|---|---|
| GoToSocial 0.22.2 | every pull request, weekly schedule and local runs | one container, SQLite |
| Mastodon 4.7.5 | weekly schedule and local runs | Postgres, Redis, three processes (docker compose) |

Mastodon is the second peer because it is the implementation most instances
use. Its job is independent from the GoToSocial job and runs only on the
weekly schedule: a heavyweight compose stack must not slow down pull requests,
but a new Mastodon release still has to be checked regularly.

Both peers are started with `network_mode: host`, so they reach the instance
under test on `localhost` and the other way round.

## Running the test

```bash
# the instance under test, with the settings the test needs
npm run dev:federation

# the peer
node scripts/federation-peer.mjs up gotosocial

# the comparison
FLAXIA_FEDERATION_PEER=gotosocial npm run test:federation
```

`dev:federation` differs from `dev:test` in two bindings:

* `AP_DIRECT_DELIVERY=1` — the activities are delivered without the queue.
  The local queue of the development server has no consumer, so a queued
  delivery would never leave the process.
* `AP_ALLOWED_PRIVATE_PEERS=localhost,127.0.0.1` — the peer and the remote
  instance of the test are on the same machine, so they are private
  addresses. Both bindings are ignored outside of the test and development
  environment.

## What the test checks

| Scenario | What it shows |
|---|---|
| WebFinger | Both instances answer with the same shape of document |
| Actor document | Both publish the properties a peer needs |
| Follow | The instance follows the peer and the peer knows the follower |
| Follow back | The peer follows the instance and the instance accepts it |
| Note | A note of the instance reaches the timeline of the peer |
| Note | A note of the peer reaches the timeline of the instance |
| Signature | Every delivered activity carries a valid signature and digest |
| Note document | Both publish a note with the same shape |
| Like | A remote Like notifies the author; Undo-Like removes it |
| Announce | A remote Announce counts as a reload; Undo-Announce reverses it |
| Delete (outbound) | A deleted local post is delivered as a Tombstone with `formerType` |
| Delete (inbound) | A deleted remote post is hidden on the instance |

The Like, Announce and Delete scenarios are driven by the remote instance of
the test (`tests/federation/remote.ts`), which signs its deliveries. Their
effect is checked on the instance under test: a Like notifies the author, an
Announce counts as a reload, and a Delete of a local post arrives as a signed
delivery whose shape is compared with `activityShape()`. These flows do not go
through the peer client, which is used only to look up accounts, post notes,
read the timeline and manage follows. The `ignore: ['Undo.object']` option of `diffShapes()` is
covered by the shape unit tests in `tests/activitypub-ap-gaps.test.ts`; the
only ignore used in this suite is for the optional actor properties
`hasLiked` and `hasSharedInbox`.

The comparison reduces a document to the properties a peer reads, because
the documents of two instances never look the same: the ids, the hosts and
the collections differ. A difference is reported with the values of both
sides, so it is clear what changed.

Some properties are optional and therefore not compared: the `liked`
collection and the shared inbox are not published by every implementation.

## The remote instance of the test

Besides the peer, the test runs a small instance of its own
(`tests/federation/remote.ts`). It publishes an actor document, signs the
activities it sends and records everything the instance under test delivers
to it. The recorded deliveries are the ground truth of the test: they show
what the instance sends, with the signature it signed it with.

The remote instance of the test publishes the discovery documents as well:
an instance resolves the account of a remote actor with them, so without
them the peer cannot verify a signature of it.

## In the CI

The workflow `.github/workflows/federation.yml` has two independent jobs.
`differential` starts the instance and GoToSocial on every pull request and
once a week; `differential-mastodon` does the same with Mastodon **only on the
weekly schedule** (45 minute timeout). A weekly run matters because a new
release of a peer may change the behaviour of the federation. Both jobs set
`FLAXIA_FEDERATION_PEER` to the peer they start; a missing or misspelled name
fails the test run instead of silently skipping it. The Mastodon job removes its
compose containers and volumes with `if: always()` cleanup, so a failed test
cannot leave a dirty runner.
