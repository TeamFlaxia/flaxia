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
        verdict ── clean: row=clean │ infected: row=infected + fileblk:{key}=1 + auto-blocklist
              │
              ▼ (serve time)
        canAccessMediaKey: fileblk marker ──► 404
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
| 2 | Declared `Content-Type` == sniffed == key extension == attachment slot kind | `type_mismatch` |
| 3 | Dimensions sane for images (PNG/GIF/JPEG structure parse) | `type_mismatch` |
| 4 | Blocklist match on any extracted feature | `file_blocked` |

Check 2 compares MIME types, not just strings: the sniffer cannot tell an
audio track from a video one, so `video/mp4`/`audio/mp4`/`video/quicktime` are
accepted for each other, as are `video/webm`/`audio/webm` (`CONTAINER_FAMILIES`
in `functions/lib/scan/mime.ts`). Without that, the `.m4a`, `.mov` and
audio-only `.webm` files the composer advertises would all fail as masquerades.

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

Hard limits: ClamAV task ≤ 20 MB, ZIP ≤ 4096 entries, PNG inflate ≤ 32 MB,
GIF ≤ 16 MP, PDF text ≤ 256 KB.

## Stage 2 — asynchronous (Crowd orchestrator)

`submitFileScans` (`functions/lib/scan/clamav.ts`) submits container tasks:

| Image | Command | Purpose |
|---|---|---|
| `clamav.wasm` | `clamscan --infected --no-summary <file>` | signature scan |
| `flaxia-video-phash.wasm` | `video-phash input.mp4` | keyframe pHashes (video only, best-effort) |

- Both use the shared Crowd env (`CROWD_ORCHESTRATOR_URL`, `CROWD_API_KEY`) —
  no new secrets. With the orchestrator unconfigured (local dev) the row is
  marked `skipped / orchestrator_unconfigured`.
- The callback URL carries `type=file-scan`, `key=<r2Key>`, `kind=clamav|video-phash`
  and `sha=<first 16 hex of sha256>`; a callback whose sha prefix no longer
  matches the row is ignored (guards stale verdicts after re-upload).
- `POST /api/crowd/webhook` → `{ received: true }`. The route is a standalone
  Pages Function, so no Hono middleware runs on it; instead every callback URL
  is signed with `sig=<HMAC-SHA256>` over the canonical path+query
  (`signedCallbackUrl` / `verifyCallbackSignature` in `functions/lib/crowd.ts`)
  and an invalid or missing signature is rejected `401` before the body is read.
  The key defaults to `CROWD_API_KEY` (set `CROWD_WEBHOOK_SECRET` to rotate it
  independently) and is empty while Crowd is unconfigured, which is what keeps
  local dev and the integration suites working unsigned.
- Because the `sha` param is attacker-controllable, it is also checked against
  the row on every destructive path — `recordInfection` and `setScanPhash` both
  refuse a prefix that does not match, so a replayed or forged callback can
  neither blocklist the current bytes nor downgrade a re-uploaded file.

### Container contract

Input: `files: { [name]: base64 }` in the `submit` payload. Output envelope:

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
| infected | row → `infected` + signature in `detail`, KV `fileblk:{key}=1`, **auto-adds sha256 to `file_blocklist`** (`added_by = system`) |
| failed / task failure | row → `failed` with reason; serving fails open |
| clean/infected never downgrades: re-upload of the same bytes keeps the verdict (sha-aware upsert) | |

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
- **Serve (asynchronous):** `canAccessMediaKey` checks the KV `fileblk:{key}`
  marker on `/api/images/*`, `/api/zip/:postId`, `/api/thumbnail/:id`,
  `/api/swf/:postId` → `404`. Infected content becomes invisible even if it
  was uploaded before the signature existed.
- **Post-verdict (fail open):** orchestrator/DB outages mark rows
  `failed`/`skipped` — serving continues, next re-upload re-evaluates.

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
  `tests/mime-guard.test.ts`, `tests/security-guards.test.ts`
  (regression guard: every R2-writing route must call `scanUploadSync`).
- Integration: `tests/file-scans.test.ts` against `npm run dev:test`
  (upload → row, blocklist CRUD, webhook clean/infected paths).
- `GET /api/test/file-scans` (test env only) returns recent rows for
  assertions.

## Known limitations

- Progressive JPEG, WebP, and palette PNG get sha256-only matching (in-Worker
  decode unsupported) — `phashNote` records why.
- pHash distance 8 is tuned for the 64-bit hash, not for adversarial
  perturbations; ClamAV remains the primary malware gate.
- `feature/pdf-attachments` is a pending branch that also touches
  `helpers.ts`/`media.ts` and claims migration `0096`.
