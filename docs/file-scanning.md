# File Security Scanning

Every upload runs through a two-stage pipeline: a **synchronous stage** in the
Worker that blocks bad bytes before they reach R2, and an **asynchronous
stage** on the Crowd orchestrator whose verdict is enforced at serve time.

```
upload ──► detect + allowlist ──► attachment kind ──► dimensions
              │
              ▼
        feature extraction (sha256 / pHash / zip hash / pdf text hash)
              │
              ▼
        blocklist match ── blocked? ──► 400, object never stored
              │
              ▼
        file_scans row (pending) + R2 put + KV pending
              │
              ▼ (async, waitUntil)
        Crowd: clamav.wasm (+ flaxia-video-phash.wasm for video)
              │
              ▼ (callback)
        verdict ── clean: row=clean │ infected: row=infected + auto-blocklist
                  skipped/too_large ──► quarantined at serve time
              │
              ▼ (serve time)
        isKeyBlocked: KV + D1 scan state ──► 404
```

## Stage 1 — synchronous (upload)

`scanUploadSync` in `functions/lib/scan/index.ts`, called by every R2 sink:
`media.ts` (PUT /api/upload/:key), `stamps.ts`, `users.ts` (avatar, header),
`posts.ts` (thumbnail), `admin.ts` (ad payload, ad thumbnail).

Order of checks; the first failure returns `400` with a typed code and the
object never reaches R2 (no `file_scans` row either):

| # | Check | Code |
|---|---|---|
| 1 | Sniffed MIME (magic bytes, `detectMimeType`) is in the image/audio/video allowlist | `unrecognized_type` |
| 2 | Declared `Content-Type` and key extension are compatible with the sniffed MIME; attachment slot kind matches it | `type_mismatch` |
| 3 | Dimensions sane for images (PNG/GIF/JPEG structure parse) | `type_mismatch` |
| 4 | Blocklist match on any extracted feature | `file_blocked` |

Check 2 compares MIME types, not just strings, and never demands an exact
match:

- `video/mp4`/`audio/mp4`/`video/quicktime` are accepted for each other, as are
  `video/webm`/`audio/webm` (`CONTAINER_FAMILIES` in
  `functions/lib/scan/mime.ts`). The sniffer cannot tell an audio track from a
  video one, so without this the `.m4a`, `.mov` and audio-only `.webm` files
  the composer advertises would all fail as masquerades.
- `DECLARED_ALIASES` maps the spellings browsers actually send — `audio/x-m4a`
  (Safari/macOS, Chrome on Windows) and `audio/x-wav` / `audio/wave` — onto
  the types the sniffer reports.
- Two allowlisted images agree with each other. `file.type` comes from the
  extension, so a JPEG re-saved as `.png` (or PNG bytes behind a `.gif` key)
  declares one image type and sniffs as another; both decode anywhere, so it is
  not a masquerade. SVG never gets this tolerance — it has no magic bytes and
  always sniffs as `text/html`.
- Anything else across classes (image/audio/video declared over HTML, SWF or
  foreign bytes, or an extension from another class) is a `type_mismatch`.
  ZIP content stays exempt from the *declared* check because game uploads carry
  page/form content types; the key's extension still judges those.

On success the Worker extracts features, inserts a `file_scans` row
(`status = pending`), writes the object, and schedules `submitFileScans` via
`waitUntil`.

## Feature extraction

`functions/lib/scan/features.ts` — all in-Worker, pure TypeScript, no native
code (Cloudflare Workers constraint):

| Kind | sha256 | structure hash | text hash | pHash |
|---|---|---|---|---|
| image (PNG / GIF / baseline JPEG) | ✔ | — | — | 64-bit luma pHash, decoded in-Worker |
| image (WebP / progressive JPEG / palette PNG) | ✔ | — | — | `null` + `phashNote` (fail-open to sha-only) |
| zip | ✔ | entry-list hash | — | — |
| pdf | ✔ | — | normalized text hash | — |
| video | ✔ | — | — | deferred — orchestrator keyframe pHash |
| audio / other | ✔ | — | — | — |

Hard limits: ZIP ≤ 4096 entries, PNG inflate ≤ 32 MB, GIF ≤ 16 MP, PDF text
≤ 256 KB. The legacy inline ClamAV path is limited to about 783 KiB raw (1 MiB
Crowd task-body cap after Base64 and JSON overhead). That cap is deliberately
clamped at 1 MiB: a Base64 task is also stored as one Durable Object value and
sent over its WebSocket, so increasing the JSON cap alone cannot safely carry a
25 MiB file. With the R2 file-source rollout enabled, files up to 25 MiB are
fetched by the node at execution time; larger files remain quarantined.

## Stage 2 — asynchronous (Crowd orchestrator)

`submitFileScans` (`functions/lib/scan/clamav.ts`) submits container tasks:

| Image | Command | Purpose |
|---|---|---|
| `FILE_SCAN_CLAMAV_IMAGE` | `clamscan --infected --no-summary <file>` | signature scan |
| `FILE_SCAN_VIDEO_PHASH_IMAGE` | `video-phash input.mp4` | keyframe pHashes (video only, best-effort) |

- Both use the shared Crowd env (`CROWD_ORCHESTRATOR_URL`, `CROWD_API_KEY`) —
  plus the two `FILE_SCAN_*_IMAGE` variables holding full HTTPS URLs of the
  browser-node WASM images. The container workload rejects bare filenames and
  local/private hosts. With the orchestrator unconfigured (local dev) the row
  is marked `skipped / orchestrator_unconfigured`; with an orchestrator but no
  ClamAV image it is marked `skipped / scan_image_unconfigured` so the gap is
  visible instead of leaving uploads pending forever.
- Files up to `clamavMaxBytes` continue using the legacy Base64 task. Its body
  ceiling is at most 1 MiB even if `CROWD_MAX_PAYLOAD_BYTES` is set higher. Files
  larger than that but no more than 25 MiB use an R2 file source only when
  `CROWD_SCAN_FILE_SOURCES=1`; with the flag absent or disabled they remain
  `skipped / too_large` and quarantined. Files above 25 MiB are always skipped.
  Roll out in order: deploy the Crowd worker, publish and deploy the updated
  `@flaxia/sdk`/`@flaxia/node`, update `CROWD_NODE_VERSION` only to that published
  node release, then enable the flag after an eligible `container` node is online.
- Configure `CROWD_NODE_ORIGINS` as a comma-separated list of exact browser
  page origins allowed to read the ticket endpoint. Each node host must opt in
  with both `containerImageOrigins` (for the trusted ClamAV WASM image) and
  `fileSourceOrigins` (for the Flaxia API origin); the Crowd coordinator only
  assigns reference tasks to nodes that advertise file-source support. The
  Flaxia page configures its own API origin. No cookies are used by the file
  fetch; CORS allows only configured origins and the `Authorization` header.
- The signed callback URL carries `type=file-scan`, `key=<r2Key>`,
  `kind=clamav|video-phash`, and `sha=<full 64-hex sha256>`. The full digest is
  the immutable scan target; 16-hex prefixes remain accepted only for callbacks
  already in flight during rollout.
- `POST /api/crowd/webhook` → `{ received: true }`. The route is a standalone
  Pages Function, so no Hono middleware runs on it; instead every callback URL
  is signed with `sig=<HMAC-SHA256>` over the canonical path+query
  (`signedCallbackUrl` / `verifyCallbackSignature` in `functions/lib/crowd.ts`)
  and an invalid or missing signature is rejected `401` before the body is read.
  The key defaults to `CROWD_API_KEY` (set `CROWD_WEBHOOK_SECRET` to rotate it
  independently) and is empty while Crowd is unconfigured, which is what keeps
  local dev and the integration suites working unsigned.
- `GET /api/crowd/scan-file` streams R2 bytes only when a short-lived HMAC
  bearer ticket is valid. The ticket binds key, SHA-256, size, and expiry; the
  handler also requires the current `file_scans` row to remain `pending`,
  `submitted`, or `clean` with the same SHA and verifies the R2 object size.
  `clean` remains readable only to support already-queued secondary video-hash
  work while its ticket is valid. The response is
  `application/octet-stream`, attachment-only, no-store, and streamed directly
  from R2. The ticket is sent in `Authorization`, never in the URL.
- The submission path binds the callback and file ticket to the bytes it
  actually holds: the full sha is computed from the upload buffer, and the task
  id is only written when the row still has that exact sha. For a large file,
  the task contains only a signed reference; the node verifies both byte count
  and SHA-256 before mounting the downloaded bytes. A same-key re-upload makes
  an old ticket unusable because the current D1 row no longer matches.
- Callback query parameters are covered by the HMAC signature. Infected verdicts
  atomically upsert the submitted full SHA into `file_blocklist` and update the
  scan row only when its SHA still matches. Thus a same-key overwrite cannot
  discard the old infected digest or mark the replacement infected; the KV key
  marker is written only when the current row matches the verdict.

### Container contract

Small legacy inputs use `files: { [name]: base64 }`. Large scan inputs use
`fileSources: { [name]: { url, token, size, sha256 } }`; the node fetches these
immediately before execution, with its configured origin allowlist, a 25 MiB
aggregate limit, and size/hash verification. The Crowd coordinator sends
file-source tasks only to nodes that advertised support. Output envelope:

```json
{ "result": { "output": { "stdout": "...", "stderr": "...", "exitCode": 0 } } }
```

- ClamAV exit `0` = clean, `1` = infected (`: <Signature> FOUND` parsed from
  stdout), `≥ 2` = failed (row → `failed`, serving fails open).
- `video-phash` stdout must contain JSON `{"phashes": ["<16 hex>", ...]}`;
  hashes are stored on the row and re-matched against the blocklist.

### Verdict handling (`functions/lib/crowd.ts`)

| Verdict | Effect |
|---|---|
| clean | row → `clean` (after a final blocklist re-check) |
| infected | exact-SHA row → `infected` when still current; **always auto-adds submitted sha256 to `file_blocklist`** (`added_by = system`); KV key marker only when the row matches |
| failed / task failure | row → `failed` with reason; serving fails open |
| skipped / `too_large` | row remains explicitly skipped; delivery is quarantined until newer bytes replace it and enter the normal scan lifecycle |
| clean/infected never downgrades: re-upload of the same bytes keeps the verdict (sha-aware upsert) | |

A `signature` blocklist entry is matched at verdict time against the ClamAV
signature name (case-insensitive substring); a match supplies the `reason`
recorded on the auto-added sha256 entry. Blocking itself does not depend on the
entry — any infected verdict is blocked.

A clean verdict never clears the key's `fileblk:` marker itself. Another
container task for the same bytes (the video pHash scan) can mark them infected
between the clean path's blocklist read and its status write; clearing there
would reopen the file. The marker instead clears lazily at serve time once the
row is verifiably not `infected`, so reused keys recover without a race.

Status lifecycle: `pending` → `submitted` (written by `setScanTask` once the
orchestrator accepts the task) → `clean` / `infected` / `failed` / `skipped`.
`submitted` must appear in the `file_scans.status` CHECK **both** in
`migrations/0097_file_scans_blocklist.sql` and in the runtime bootstrap in
`functions/lib/scan/db.ts`; SQLite rejects the write otherwise and the whole
submission path silently fails. `tests/file-scan-schema.test.ts` pins the two
copies together.

## Enforcement

- **Upload (fail closed):** stage-1 checks block anything known-bad before
  storage; the synchronous blocklist match is the hard gate.
- **Serve (asynchronous):** every path that returns bytes checks the KV marker
  and D1 scan row: infected rows and `skipped/too_large` rows return `404`, even
  if a KV marker write was lost. This covers `/api/images/*`, `/api/audio/*`,
  `/api/video/*`, `/api/zip/:postId`, `/api/thumbnail/:id`, `/api/swf/:postId`,
  `/api/ads/:id/payload`, and the sandbox's `wvfs/` and `zip/` lookups. The
  sandbox checks the source archive before serving any CDN-cached extracted
  file, so a blocked ZIP cannot keep leaking through `wvfs/`. Reused keys clear
  stale infection markers only after D1 confirms the row is no longer infected;
  KV or D1 read errors fail closed.
- **Post-verdict:** Crowd outages may leave rows `failed`/`skipped` (except
  `skipped/too_large`, which is quarantined); the next upload is evaluated
  again. KV or D1 errors during serve-time verification fail closed.

## Re-screening quarantined images

`POST /api/admin/rescreen-quarantined` is a bounded, admin-only recovery path
for image objects recorded in `file_scans` as `skipped` with `detail` equal to
`too_large` or `orchestrator_unconfigured`. The endpoint processes at most 100 rows per request (default 25;
optional JSON body `{ "limit": 50 }`). It re-reads the R2 object, accepts only
images within the configured scan limits, requires the bytes' SHA-256 to match
the quarantined scan row, and submits those exact bytes to ClamAV. Inline scan
size is constrained by the configured Crowd payload limit. When
`CROWD_SCAN_FILE_SOURCES=1` is explicitly enabled, images up to 25 MiB may use
R2-backed scan tickets; this feature flag remains off by default. Candidates
above the active scan limit stay quarantined and are reported as `too_large`.
The endpoint never serves the object early or
clears an infection verdict; it remains blocked until
a matching clean callback arrives.
Missing, changed, unsupported, and failed objects are reported separately in
the response's `results` counts.

## Blocklist admin API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/file-blocklist` | `{ entries: [...] }` |
| POST | `/api/admin/file-blocklist` | `{ kind, value, signature?, reason? }` → `201` (upsert on kind+value) |
| DELETE | `/api/admin/file-blocklist/:id` | Remove → `{ ok: true }` |

Kinds: `sha256` / `structure_hash` / `text_hash` (64 hex), `phash` (16 hex,
Hamming distance ≤ `PHASH_MAX_DISTANCE = 8`), `signature` (≤ 200 chars,
substring of the ClamAV verdict name).

## Testing

- Unit: `tests/file-features.test.ts`, `tests/file-blocklist.test.ts`,
  `tests/clamav-payload.test.ts`, `tests/crowd-scan-file.test.ts`, `tests/file-scan-race.test.ts`,
  `tests/mime-guard.test.ts`, `tests/security-guards.test.ts` (regression guard:
  every R2-writing route must call `scanUploadSync`).
- Integration: `tests/file-scans.test.ts` against `npm run dev:test`
  (upload → row, blocklist CRUD, webhook clean/infected paths).
- `GET /api/test/file-scans` (test env only) returns recent rows for
  assertions.

## Known limitations

- Progressive JPEG, WebP, and palette PNG get sha256-only matching (in-Worker
  decode unsupported) — `phashNote` records why.
- pHash distance 8 is tuned for the 64-bit hash, not for adversarial
  perturbations; ClamAV remains the primary malware gate.
- pHash drops coefficients below `1e-9` of the strongest before the median and
  the bit decisions (same floor as the comparison margin). Without it, a flat
  or symmetric image hashes its own floating-point rounding noise, so identical
  pictures could land far apart.
- `feature/pdf-attachments` is a pending branch that also touches
  `helpers.ts`/`media.ts` and claims migration `0096`.
