# Flaxia Mail

**Status:** design only — no production code yet.

Flaxia Mail is a real mailbox on `@flaxia.app`: it receives mail from the
public SMTP network, sends mail to external recipients, and exposes a webmail
UI inside Flaxia. It is not a revival of the removed Lounge/DM feature
(`migrations/0089_drop_lounge_tables.sql`) and does not reuse its tables.

This document is the implementation contract. Code that contradicts it is a
bug, the same rule `docs/e2ee.md` uses for the Personal Vault.

Last updated: 2026-11-05.

---

## 1. Goals

- Give every eligible Flaxia account a real address such as
  `username@flaxia.app`.
- Receive external mail from arbitrary SMTP senders and send mail to arbitrary
  external recipients.
- Provide inbox, threads, compose, reply, attachments, drafts, labels,
  archive, spam, trash, and search.
- Encrypt stored mail so a D1/R2 dump or backup does not expose message
  bodies, subjects, attachment names, or label names.
- Give Flaxia-to-Flaxia mail true end-to-end encryption.
- Reuse the Personal Vault key hierarchy and device approval flow rather than
  inventing a second key system.
- Keep the MX/routing change compatible with existing `flaxia.app` human mail
  forwarding.

## 2. Non-goals (MVP)

- PGP, S/MIME, or external end-to-end encryption.
- Custom domains, shared team mailboxes, or catch-all aliases for arbitrary
  domains.
- IMAP, POP3, JMAP, CalDAV, or CardDAV.
- Server-side full-text search over encrypted bodies.
- Bulk/marketing mail, newsletters, or mailing lists.
- Calendar, contacts sync, vacation responders, scheduled send, or send-later.
- Forwarding rules, filters, or server-side auto-replies.

PGP/S/MIME may be added later. Until then external mail is **not** described as
end-to-end encrypted anywhere in the UI or docs.

---

## 3. Current state and constraints

| Item | Finding |
|---|---|
| Existing mail feature | None. `mail` references in the repo are authentication email only. |
| Removed DM/Lounge | Dropped by `migrations/0089_drop_lounge_tables.sql`; do not reuse `dm_*`, `group_*`, or `server_*` tables. |
| `flaxia.app` MX | Already Cloudflare Email Routing (`route1-3.mx.cloudflare.net`). |
| SPF | `v=spf1 include:_spf.mx.cloudflare.net ~all` present. |
| Inbound DKIM | `cf2024-1._domainkey.flaxia.app` present. |
| Outbound sending | Not onboarded: no `cf-bounce` MX/DKIM records. |
| DMARC | Not present. |
| Auth identity | Username-first (`/^[A-Za-z0-9_]{1,20}$/`, case-insensitive). Email is optional and unverified. |
| Username changes | No rename endpoint exists today. Mail addresses therefore remain stable; if rename is added later, old addresses must stay as aliases. |
| E2EE | Personal Vault exists (`docs/e2ee.md`); reuse its VK, device approval, and vault-item storage. |
| API/UI | Hono router in `functions/api/[[route]].ts`; SPA routes in `src/lib/router.ts`; left nav in `src/components/LeftNav.ts`. |

### Hard platform constraints

- Cloudflare Email Routing requires exclusive control of the root-domain MX
  records. It cannot coexist with another MX provider on the same domain.
- Cloudflare Email Sending is a separate onboarding step from Email Routing;
  the sending domain needs `cf-bounce` MX, SPF, DKIM, and DMARC records.
- Inbound messages and Workers have size and CPU limits. Re-check current
  Cloudflare limits during implementation; the MVP caps inbound messages at
  10 MiB even if the platform allows more.
- Cloudflare Email Workers run on the Workers runtime, not Pages Functions.
  Receiving therefore requires a separate Worker or Worker route.
- D1 is a single SQLite database per binding (currently a 10 GB class). Mail
  volume must not be mixed into the main `flaxia` D1 database.
- `allow-same-origin` is permanently banned on all iframes, including any
  mail renderer.

---

## 4. Decisions

| # | Decision | State |
|---|---|---|
| D1 | Mail is a real `@flaxia.app` mailbox, not in-app DM | Approved |
| D2 | Separate `flaxia-mail` Worker with its own D1/R2/Queue | Approved |
| D3 | Pages Functions authenticate the session and proxy to the Worker | Approved |
| D4 | Personal Vault is required to activate a Mail address | Recommended, confirm at implementation |
| D5 | Flaxia-to-Flaxia mail is true E2EE; external mail is TLS + encrypted at rest | Recommended, confirm |
| D6 | Apex `@flaxia.app` first, or `@mail.flaxia.app` beta first | Open |
| D7 | Eligibility: all users, Flaxia+, or trust-gated | Open |
| D8 | Storage/send quotas and retention periods | Open |

`D5` is the important honesty boundary. A public sender has no Flaxia key, so
external mail cannot be end-to-end encrypted. Encrypting it immediately after
receipt protects backups and database dumps, but the receiving Worker sees the
plaintext during ingestion. The UI must say so.

---

## 5. Architecture

```
External SMTP
    |
    | MX (Cloudflare Email Routing)
    v
flaxia-mail Worker
    |- email()    receive, MIME parse, auth checks, encryption
    |- queue()    attachment scan, metadata/index preparation, retries
    |- fetch()    internal mail API (send, list, actions, labels, keys)
    |
    | bindings: MAIL_DB / MAIL_BUCKET / MAIL_QUEUE / MAIL_SEND
    ^
    | Service Binding, signed user identity
    |
flaxia Pages Functions
    |- /api/mail/*  session auth, CSRF, rate limit, proxy
    ^
    | HTTPS
    |
SPA (vanilla TypeScript)
    |- MailPage / MailList / MailThread / MailComposer
    |- src/lib/mail/*  decryption, search, MIME rendering
    |- Personal Vault unlock supplies the Mail identity private key
```

### Why a separate Worker and database

- Pages Functions cannot receive Email Routing events.
- Mail writes are large and bursty; a separate D1 keeps the main database
  predictable.
- A separate R2 bucket gives independent retention, lifecycle, and deletion.
- Mail can be disabled or rate-limited without redeploying the main app.

### Planned layout

```
mail-worker/
  wrangler.toml
  src/index.ts          fetch(), email(), queue() exports
  src/ingest.ts         inbound pipeline
  src/parse.ts          MIME parsing and header normalization
  src/send.ts           outbound pipeline and MIME builder
  src/storage.ts        D1/R2 helpers
  src/crypto.ts         ECIES content-key wrapping (server side)
  src/render.ts         HTML sanitization helpers shared with tests
functions/api/routes/mail.ts   authenticated proxy to MAIL_SERVICE
src/components/Mail*.ts        webmail UI
src/lib/mail/*                 client crypto, search, address helpers
migrations/mail/               MAIL_DB migrations
tests/mail-*.test.ts           unit/integration tests
tests/fixtures/mail/*.eml      inbound fixtures
```

Shared pure modules (address normalization, MIME header encoding, date
formatting) should live in one place consumed by both the Worker and the SPA,
rather than being copied. Keep the client and server E2EE primitives
byte-compatible and cover them with known-answer tests.

### Bindings

| Binding | Type | Purpose |
|---|---|---|
| `MAIL_DB` | D1 | Mail metadata, keys, labels, jobs |
| `MAIL_BUCKET` | R2 | Encrypted payloads, attachments, encrypted raw MIME |
| `MAIL_QUEUE` | Queue | Async scan/index/cleanup work |
| `MAIL_QUEUE_DLQ` | Queue | Failed job quarantine |
| `MAIL_SEND` | `send_email` | External SMTP submission |
| `MAIL_SERVICE` | Service binding (Pages side) | Pages → Worker |
| `MAIL_INTERNAL_SECRET` | Secret | Signature for trusted Pages → Worker calls |
| `MAIL_THREAD_SECRET` | Secret | HMAC for subject-based thread fallback |
| `MAIL_DOMAIN` | Var | `flaxia.app` or the beta subdomain |
| `MAIL_FALLBACK_FORWARD` | Var | Existing human mailbox for unknown recipients |

The Mail Worker must not expose a public `workers.dev` route. Only the Service
Binding and the Email Routing handler are reachable. Internal requests carry
the authenticated user id and an HMAC; the Worker validates both even though
Service Bindings are already trusted.

---

## 6. Security and encryption

### 6.1 Confidentiality tiers

| Path | Protection | Server sees | UI label |
|---|---|---|---|
| Flaxia → Flaxia | Client-to-client E2EE | Envelope, timestamps, size, label ids, read state | `End-to-end encrypted` |
| External → Flaxia | TLS on the wire, encrypted immediately after ingest | Plaintext during Worker ingestion | `Encrypted at rest` |
| Flaxia → External | TLS to the recipient's SMTP server | Plaintext while building and sending | `TLS only` |
| External → External | Not handled by Flaxia | — | — |

Internal E2EE only applies when **every** recipient and the sender have
Flaxia Mail keys. If any external recipient is present, the message takes the
external path and is `TLS only` for all recipients. This keeps one code path
and avoids sending two different bodies with the same subject.

### 6.2 Key hierarchy

```
Personal Vault VK
  |
  +-- AES-GCM wrap --> Mail identity private key (P-256, PKCS#8)
  |                         |
  |                         +-- ECDH + HKDF --> shared key
  |                                                  |
  +-- HKDF --> mailbox metadata key                  |
                 |                                   |
                 +-- AES-GCM --> label names,        |
                                 local index keys    |
                                                     v
per-message content_key -- AES-256-GCM --> payload and attachments
        |
        +-- wrap for each recipient's P-256 public key (ECIES)
```

- **Mail identity:** one P-256 ECDH key pair per key version. The public key
  is stored in `mail_identities`; the private key is a Personal Vault item of
  kind `mail_identity`, wrapped by VK. The server never sees VK or the
  unwrapped private key.
- **Content key:** random 32 bytes per message. The payload is encrypted once
  with AES-256-GCM; the content key is wrapped separately for every recipient
  and for the sender's Sent copy.
- **Wrapping:** ephemeral P-256 ECDH, HKDF-SHA256 with
  `info = "flaxia.mail.wrap.v1:<message_id>:<recipient_address>"`, then
  AES-256-GCM. The AAD binds the wrap to the message and recipient so a
  wrapped key cannot be moved to another row.
- **Attachments:** each attachment key is derived from the content key with
  `HKDF(content_key, info = "flaxia.mail.attachment.v1:<attachment_id>")`.
  Attachment ciphertext lives in R2; names and content types are encrypted in
  the message metadata.
- **Labels and mailbox metadata:** derived from VK with
  `HKDF(VK, info = "flaxia.mail.meta.v1")`. A VK rotation re-encrypts these
  values client-side.
- **Local search index:** encrypted with the device's non-extractable key and
  stored in IndexedDB. It is never uploaded.

Cryptography uses WebCrypto (`AES-GCM`, `ECDH` P-256, `HKDF`, `SHA-256`) and
`@noble/*` only where WebCrypto lacks a primitive. Do not add ad-hoc
constructions; keep the same rules as `docs/e2ee.md`.

### 6.3 Identity lifecycle

1. The user enables the Personal Vault, or unlocks an existing one.
2. The client generates a P-256 key pair and wraps the private key under VK.
3. The private key is stored as a `mail_identity` vault item.
4. The public key and `key_version` are published to `mail_identities`.
5. Inbound external mail is encrypted to the current public key.
6. Internal senders fetch recipient public keys and encrypt client-side.

Key rotation creates a new `key_version` row and leaves old private keys in
the vault so old messages remain readable. Re-encrypting all historical mail
is not required. If an old private key is compromised, historical
confidentiality cannot be restored; the UI must say that rotation protects
new mail only.

Vault rotation re-wraps the Mail private keys and re-encrypts metadata. Losing
the vault (no recovery phrase and no approved device) makes Mail unreadable;
this is the same failure mode as other vault data and must be warned about
before activation.

### 6.4 Threat model

| # | Adversary | In scope | Mitigation |
|---|---|---|---|
| M1 | D1/R2 dump or stolen backup | Yes | Bodies, subjects, attachment names, label names are ciphertext |
| M2 | Passive network observer | Yes | TLS for HTTP and SMTP |
| M3 | Operator reading stored mail | Yes | Server holds no VK; internal mail is opaque |
| M4 | Stolen device | Yes | Vault device approval and revocation |
| M5 | Hostile Worker deploy | Partial | Cannot prevent a modified build from reading plaintext at ingest or unlock |
| M6 | XSS in the main origin | Out of band | CSP, sandboxed mail renderer, no scripts |
| M7 | Phishing/spam sender | Partial | SPF/DKIM/DMARC, warnings, blocklists, user reports |
| M8 | Coerced user | Out of scope | — |

**Honest limit:** external inbound mail is plaintext at the moment the Email
Worker receives it. This design protects data at rest and in backups, not
against a live operator or a malicious deployment reading it during ingest.
External outbound mail is also plaintext to the sending Worker. Do not market
either path as end-to-end encrypted.

---

## 7. Data model

Mail data lives in `MAIL_DB`, not the main `flaxia` database. User identity is
the existing `users.id`; address provisioning checks it through the Pages
proxy before creating rows.

### `mail_addresses`

| Column | Notes |
|---|---|
| `address` | Primary key, lowercase `local@domain` |
| `user_id` | Flaxia user id |
| `kind` | `primary` or `alias` |
| `state` | `active` or `disabled` |
| `created_at`, `disabled_at` | ISO timestamps |

One primary address per user. Reserve `admin`, `abuse`, `dmarc`, `noreply`,
`postmaster`, `security`, `support`, `team`, and similar names. Alias support
can land after the MVP.

### `mail_identities`

| Column | Notes |
|---|---|
| `user_id` | Primary key |
| `address` | Published address |
| `public_key` | P-256 SPKI base64 |
| `key_version` | Integer version |
| `created_at`, `updated_at` | |

Old versions are kept in `mail_identity_versions` if key rotation needs
multiple active public keys. The MVP may rotate by adding a version row and
updating the current pointer.

### `mail_threads`

`id`, `user_id`, `subject_enc`, `last_message_at`, `message_count`,
`unread_count`, `participants_enc`, `created_at`, `updated_at`.

### `mail_messages`

| Column | Notes |
|---|---|
| `id` | Server-generated UUID |
| `user_id` | Mailbox owner |
| `thread_id` | Thread |
| `direction` | `inbound`, `outbound`, `internal`, `draft` |
| `folder` | `inbox`, `sent`, `drafts`, `archive`, `spam`, `trash` |
| `from_addr`, `to_addr` | Envelope routing values |
| `from_name_enc`, `to_enc`, `cc_enc`, `bcc_enc`, `reply_to_enc` | Encrypted display data |
| `subject_enc` | Encrypted subject |
| `meta_enc` | Small encrypted JSON for list rows: subject, sender display name, snippet, attachment names |
| `message_id_hash` | Hash of RFC Message-ID |
| `in_reply_to_hash`, `references_hash` | Threading hashes |
| `sent_at`, `received_at` | Timestamps |
| `size_bytes`, `has_attachments` | Metadata |
| `read_at`, `starred_at` | Flags |
| `security` | `e2ee`, `at_rest`, `tls` |
| `auth_results` | SPF/DKIM/DMARC summary for warnings |
| `spam_score` | Optional heuristic score |
| `blob_id` | Encrypted payload blob |
| `raw_blob_key` | Encrypted original MIME, optional |
| `deleted_at` | Soft delete |

`meta_enc` must stay small (target < 8 KiB) so listing does not fetch the full
payload from R2.

### `mail_message_keys`

`message_id`, `recipient_address`, `key_version`, `ephemeral_public_key`,
`iv`, `wrapped_content_key`. One row per recipient. The sender's Sent copy is
another row for the sender's own address.

### `mail_blobs`

`id`, `r2_key`, `size_bytes`, `content_hash`, `ref_count`, `created_at`.
Multiple recipients of the same internal message share one ciphertext blob;
`ref_count` drives garbage collection.

### `mail_attachments`

`id`, `message_id`, `user_id`, `filename_enc`, `content_type`, `size_bytes`,
`r2_key`, `content_hash`, `scan_status`, `cid_enc`.

### `mail_labels`, `mail_message_labels`

`mail_labels`: `id`, `user_id`, `name_enc`, `color`, `system`, `sort_order`.
`mail_message_labels`: `message_id`, `label_id`, `user_id`.

Names are encrypted. The server stores stable label ids so folder/label
filters do not require decrypting names.

### Operational tables

- `mail_usage`: storage bytes and daily send counters per user.
- `mail_ingest_jobs`: inbound job state, attempts, last error.
- `mail_outbound_jobs`: external send state, provider message id, attempts.
- `mail_deletion_jobs`: account deletion and R2 garbage collection.
- `mail_events`: sync cursor and notification hints.
- `mail_local_index` is not server-side; it lives encrypted in the browser.

### R2 layout

```
mail/<user_id>/<message_id>/payload.enc
mail/<user_id>/<message_id>/attachments/<attachment_id>.enc
mail/<user_id>/<message_id>/raw.eml.enc
staging/<message_id>/...        # short TTL, only when scanning requires it
```

Encrypted raw MIME is optional but useful for "download original". It must be
encrypted with the message content key before it is persisted; never leave a
plaintext `.eml` in R2 after processing. If a scan requires a plaintext
temporary copy, put it under `staging/` with a one-hour lifecycle rule and
delete it explicitly on success.

---

## 8. API

All public endpoints are under `/api/mail/*` on the main origin. The Pages
route authenticates the session, applies CSRF and rate limits, then calls the
Mail Worker through `MAIL_SERVICE` with the user id and an HMAC. The worker
never trusts a user id supplied directly by a browser.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/mail/addresses` | List the caller's addresses |
| `POST` | `/api/mail/addresses` | Activate an address (requires vault) |
| `PATCH` | `/api/mail/addresses/:address` | Rename display label or add alias |
| `DELETE` | `/api/mail/addresses/:address` | Disable an alias or the mailbox |
| `GET` | `/api/mail/threads` | List threads by folder/label/cursor |
| `GET` | `/api/mail/threads/:id` | Thread details and encrypted metadata |
| `GET` | `/api/mail/messages/:id` | Message metadata |
| `GET` | `/api/mail/messages/:id/payload` | Encrypted payload reference or bytes |
| `POST` | `/api/mail/messages` | Send a message |
| `POST` | `/api/mail/drafts` | Create a draft |
| `PATCH` | `/api/mail/drafts/:id` | Update a draft |
| `DELETE` | `/api/mail/drafts/:id` | Delete a draft |
| `POST` | `/api/mail/messages/actions` | Batch read/star/archive/spam/trash/restore/delete |
| `GET` | `/api/mail/labels` | List labels |
| `POST` | `/api/mail/labels` | Create a label |
| `PATCH` | `/api/mail/labels/:id` | Rename or recolor |
| `DELETE` | `/api/mail/labels/:id` | Delete a label |
| `PUT` | `/api/mail/messages/:id/labels` | Replace a message's labels |
| `GET` | `/api/mail/contacts?q=` | Recipient suggestions |
| `GET` | `/api/mail/keys/me` | Current public key and version |
| `PUT` | `/api/mail/keys/me` | Publish a new public key version |
| `GET` | `/api/mail/keys?addresses=` | Fetch public keys for internal E2EE |
| `GET` | `/api/mail/quota` | Storage and send counters |
| `POST` | `/api/mail/report-abuse` | Report spam/phishing |

Rules:

- Every mutation requires an `Idempotency-Key`. Sending and account actions
  are safe to retry.
- Pagination uses opaque cursors, not offsets.
- Request and response bodies never include plaintext message content on the
  server side except in the external-send endpoint, which is explicitly
  documented as `tls`.
- Errors use stable codes such as `mail_vault_required`,
  `mail_address_taken`, `mail_quota_exceeded`, `mail_rate_limited`, and
  `mail_send_failed`.
- The worker's internal API is not routable from the internet.

---

## 9. Mail pipeline

### 9.1 Inbound

1. Email Routing routes `*@<MAIL_DOMAIN>` to the Worker.
2. Resolve the recipient in `mail_addresses`.
   - Unknown address: forward to `MAIL_FALLBACK_FORWARD` if configured, or
     reject with `550`.
   - Disabled/frozen account: reject; do not queue.
3. Enforce size and recipient limits. The MVP accepts at most 10 MiB.
4. Check SPF/DKIM/DMARC results from the incoming message. Reject clear
   authentication failures; quarantine ambiguous ones as spam.
5. Parse MIME: text, HTML, attachments, headers, inline CIDs, and the
   original raw message.
6. Scan attachments through the existing scanning pipeline.
   - Block executable and script attachments by extension and MIME type.
   - If scanning is unavailable, quarantine rather than silently deliver.
7. Generate a content key and wrap it for the recipient identity.
8. Encrypt payload, attachments, and optional raw MIME; write D1 metadata and
   R2 objects.
9. Delete plaintext staging data.
10. Thread the message using `References`/`In-Reply-To`; fall back to an HMAC
    of the normalized subject with `MAIL_THREAD_SECRET`.
11. Update usage counters, `mail_events`, and the notification badge.
12. Send a push notification that contains only "new mail", never a subject or
    snippet.

The ingestion path should complete encryption before acknowledging the message
where possible. If a queue is required for scanning, the plaintext staging
copy is short-lived and access-controlled; this is a documented weakening of
at-rest protection for that window.

### 9.2 Outbound

**All recipients are Flaxia Mail users with keys**

1. The client resolves recipient public keys.
2. It generates a content key, encrypts the payload once, and wraps the key
   for every recipient plus the sender.
3. It posts only ciphertext to `/api/mail/messages`.
4. The Worker writes message rows for each recipient mailbox and a Sent copy
   for the sender. No SMTP is used.
5. The server never sees subject, body, or attachment names.

**Any external recipient**

1. The client sends the plaintext message over TLS to `/api/mail/messages`
   with `security: "tls"`.
2. The Worker validates the sender address, recipient count, rate limits, and
   quotas.
3. It builds MIME (`multipart/alternative` plus attachments), generates
   `Message-ID`, and sends with `MAIL_SEND.send()`.
4. It stores the Sent copy encrypted to the sender's public key.
5. On transient failure it records an outbound job and retries with bounded
   backoff. Daily quota errors are returned to the client.
6. Bounces and complaints update the suppression state; repeated failures
   disable external sending for the account.

The external-send path must guard against header injection by rejecting CR/LF
in address and subject fields and by encoding non-ASCII headers per RFC 2047.

### 9.3 Threading

- Store hashes of `Message-ID`, `In-Reply-To`, and `References`, not the raw
  values, for encrypted mail.
- For external inbound mail the raw headers are available at ingest; hash them
  before storage.
- For internal mail the client provides the parent message id hash and, when
  replying, the thread id. The Worker validates that the sender participates
  in that thread.
- A new subject-based thread fallback uses HMAC-SHA256 with
  `MAIL_THREAD_SECRET` so a database dump cannot dictionary-attack subjects.
- Never merge threads across different mailbox owners.

### 9.4 HTML rendering

- Render HTML inside a `sandbox` iframe with no `allow-scripts` and no
  `allow-same-origin`.
- Sanitize with DOMPurify before insertion.
- Strip scripts, event handlers, forms, meta refresh, iframes, and object/embed
  tags.
- Block remote images by default. When the user enables them, fetch through a
  proxy that rejects private, loopback, link-local, and metadata IPs and
  limits redirects.
- Show the real link target before navigation. Open external links with
  `rel="noopener noreferrer"`.
- Do not execute HTML, ZIP, SWF, or other active attachments. Existing image,
  audio, video, and PDF viewers may be reused after decryption.
- Strip CSS `url()` and other exfiltration vectors unless a property is on an
  allowlist.

---

## 10. Client UX

### Routes

Add these views to `src/lib/router.ts`:

- `/mail` — three-pane mailbox
- `/mail/thread/:id` — thread view
- `/mail/compose` — compose
- `/mail/settings` — addresses, signature, notifications, quota

Mobile collapses to a list/detail pair. Add a Mail item and unread badge to
`src/components/LeftNav.ts` next to Notifications.

### Mailbox

- System folders: Inbox, Sent, Drafts, Archive, Spam, Trash, All Mail.
- Archive removes a message from Inbox but keeps it in All Mail.
- Spam and Trash auto-delete after 30 days by default.
- Read/unread, star, labels, bulk selection, and keyboard shortcuts
  (`j`/`k`, `Enter`, `r`, `a`, `e`, `#`, `/`).
- Thread view renders messages newest-last, collapses quoted text, and
  supports reply/reply-all/forward.

### Compose

- From selector when the user has aliases.
- To/Cc/Bcc with autocomplete from Flaxia users and recent senders.
- Subject, rich text or plain text, attachments.
- A security indicator per message: `E2EE`, `Encrypted at rest`, or `TLS only`.
- Warn when an external recipient is added: "External recipients can read this
  message. Flaxia encryption does not apply."
- Drafts are encrypted and survive reload when the vault is unlocked.

### Search

- Server-side filters: folder, label id, date range, read state, attachment
  presence, hashed participant.
- Client-side full-text search over decrypted subject, snippet, participants,
  attachment names, and (after background sync) body text.
- Build the index with a small serializable library such as MiniSearch, keep it
  in memory while unlocked, and persist it encrypted with the device key.
- Search syntax: `from:`, `to:`, `subject:`, `label:`, `has:attachment`,
  `is:unread`, `before:`, `after:`.
- D1 FTS5 is available but is deliberately not used for encrypted message
  content; it may be used for non-sensitive operational indexes only.

### Notifications

- New-mail badge through the existing notification stream and web push/FCM.
- Push text contains no subject, sender name, or body.
- Per-user preferences: all mail, inbox only, or off.
- Opening a message marks it read through the idempotent actions endpoint.

---

## 11. Operations

### 11.1 DNS and Email Routing

1. Audit every existing Email Routing rule and destination before changing
   anything. Record human addresses, catch-all behavior, and fallback targets.
2. Keep existing human mailboxes working. The catch-all should route to the
   Mail Worker, which forwards unknown recipients to `MAIL_FALLBACK_FORWARD`
   instead of dropping them.
3. Start with a beta subdomain such as `mail.flaxia.app` if the apex cutover
   risk is too high; move to `flaxia.app` after deliverability is proven.
4. Add `postmaster@` and `abuse@` routing; providers expect them.
5. Onboard the sending domain in Cloudflare Email Service and verify the
   `cf-bounce` MX, SPF, and DKIM records.
6. Publish DMARC at `p=none` with reporting, then move to `quarantine` and
   `reject` after monitoring.
7. Do not proxy mail-related DNS records. They must be DNS-only.

### 11.2 Quotas

| Resource | MVP default |
|---|---|
| Inbound message size | 10 MiB |
| Outbound message size | 10 MiB |
| Attachments per message | 20 |
| Recipients per message | 20 |
| Daily external sends | 20 (new accounts), raise with trust |
| Mailbox storage | 1 GiB (free), 10 GiB (Flaxia+) |
| Trash/Spam retention | 30 days |
| Inbound/outbound job retention | 30 days |
| Staging plaintext retention | 1 hour |

All values are configuration, not hard-coded constants. Enforce storage quotas
at ingest and before accepting outbound attachments.

### 11.3 Retention and deletion

- Soft-delete messages first; a scheduled job purges rows and R2 objects after
  the retention window.
- Account deletion must create a `mail_deletion_jobs` row, delete D1 rows, and
  remove R2 objects idempotently. Hook this into the existing account deletion
  flow (`functions/lib/account-deletion.ts`) through the Mail Service Binding.
- Disabled or deleted addresses must not receive new mail. Reject at SMTP if
  possible; otherwise quarantine and alert.
- Deleted addresses are not reusable for at least 90 days, to prevent
  misdirected mail and impersonation.
- The client can export decrypted mail only while the vault is unlocked.
  Server-side export contains ciphertext and is not useful without the key.

### 11.4 Abuse and deliverability

- Only authenticated users may send, and only from their own active address.
- No open relay. No arbitrary `From` or `Return-Path`.
- Rate-limit by user, recipient count, and content size.
- Gate external sending by account age, trust score, or Flaxia+; start
  conservative for new accounts.
- Maintain a suppression list for bounces and complaints.
- Monitor bounce and complaint rates; disable external sending automatically
  above thresholds.
- Provide user reporting for spam/phishing and an operator review path.
- Add Mail-specific clauses to the terms and privacy policy. The privacy
  policy must not claim external mail is end-to-end encrypted.

### 11.5 Monitoring

- Ingest: accepted, rejected, parse failures, encryption failures, queue
  depth, DLQ size, latency.
- Send: success, transient failure, daily quota hits, bounces, complaints,
  suppression growth.
- Storage: D1 size, R2 bytes, per-user quota violations.
- Security: auth failures, rate limits, cross-user access attempts, SSRF
  blocks, scan failures.
- Alerts for queue backlog, send failure spikes, and bounce-rate thresholds.

Logs must not contain message bodies, subjects, attachment names, or full
address lists. Log ids and counts only.

---

## 12. Testing

### Unit

- Address normalization, reserved names, alias resolution, case handling.
- Header encoding/decoding, CRLF injection rejection, Message-ID generation.
- MIME parse and thread resolution.
- ECIES wrap/unwrap and known-answer tests for content-key wrapping.
- Attachment key derivation.
- Search query parser and label/folder transitions.
- Quota and rate-limit math.

### Integration

- Inbound fixtures: plain text, HTML, multipart/alternative, inline images,
  attachments, non-ASCII headers, malformed MIME, oversized message, duplicate
  delivery.
- External → Flaxia → webmail display → reply.
- Flaxia → external delivery with a mocked `send_email` binding.
- Flaxia → Flaxia E2EE round trip; verify the server stores no plaintext.
- Vault locked, wrong key version, device revoked, recovery phrase path.
- Account deletion removes mail rows and R2 objects.
- Daily send quota and retry behavior.

### Security

- XSS payloads in HTML, SVG, and CSS.
- CSS `url()` and tracking-pixel exfiltration.
- SSRF in the image proxy, redirects to private addresses, DNS rebinding.
- Header injection and spoofed `From`.
- Cross-user message, thread, attachment, and R2 key access.
- Zip bombs, executable attachments, path traversal in attachment ids.
- DMARC failure handling and spam quarantine.
- Ensure no endpoint accepts plaintext for an `e2ee` message.

### Acceptance

- Gmail and Outlook accept Flaxia outbound mail with SPF, DKIM, and DMARC
  passing.
- Internal E2EE messages cannot be decrypted from a D1/R2 dump.
- External inbound messages are ciphertext at rest after processing.
- Search, labels, archive, spam, and trash behave as specified.
- HTML mail cannot execute scripts or contact third parties without consent.
- Account deletion leaves no mail rows or R2 objects.
- `npm run typecheck`, `npm run lint`, and the relevant test suites pass.

---

## 13. Rollout

| Phase | Estimate | Deliverable |
|---|---|---|
| P0 Design/spike | 1–2 weeks | This document, ADRs, Email Worker receive spike, `send_email` spike, ECIES round trip, HTML sanitization spike, confirmed Cloudflare limits |
| P1 Foundation | 2 weeks | Mail D1/R2/Queue, migrations, address and identity APIs, vault integration, settings UI |
| P2 Receive/read | 2–3 weeks | Inbound pipeline, MIME parse, encrypted storage, threading, list/thread UI, HTML renderer, notifications |
| P3 Send/reply | 2 weeks | Compose, drafts, external SMTP, internal E2EE delivery, Sent, retries, bounces |
| P4 Mailbox management | 2 weeks | Labels, archive, spam/trash, search, bulk actions, keyboard shortcuts, i18n |
| P5 Hardening/GA | 2–3 weeks | Security review, load tests, deliverability tuning, abuse controls, monitoring, docs, staged release |

Rough total: 10–12 weeks for one or two engineers. P0 must finish before P1
starts; its purpose is to falsify platform assumptions early.

Feature-flag Mail per user/address. Start with an internal allowlist, then a
small external beta, then general availability. Keep the ability to disable
inbound delivery and external sending independently.

---

## 14. Open questions

1. **Domain:** start at `@flaxia.app` or beta at `@mail.flaxia.app`?
2. **E2EE boundary:** confirm internal E2EE plus external TLS/at-rest
   encryption. If external E2EE is mandatory, PGP/S/MIME becomes a
   prerequisite.
3. **Eligibility:** all accounts, Flaxia+, or trust-gated?
4. **Existing routing:** what are the current Email Routing rules, catch-all,
   and human destinations that must keep working?
5. **Vault requirement:** is requiring Personal Vault activation acceptable
   for Mail? Recommended because Mail keys live under VK.
6. **Quotas/retention:** confirm the defaults in section 11.2.
7. **Attachments:** confirm the 10 MiB cap and the executable blocklist.
8. **Operations:** who owns `postmaster@`, `abuse@`, and incident response?

---

## 15. References

- `docs/e2ee.md` — Personal Vault key hierarchy and threat model.
- `docs/architecture.md` — two-origin model and Cloudflare bindings.
- `docs/api.md` — existing API conventions.
- `migrations/0089_drop_lounge_tables.sql` — removed Lounge schema; do not
  reuse it.
- Cloudflare Email Routing / Email Service: routing rules, send bindings,
  limits, subdomains, SPF/DKIM/DMARC, and local testing.
- Cloudflare D1: FTS5 support, per-query limits, and export limitations with
  virtual tables.
