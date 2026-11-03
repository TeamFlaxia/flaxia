# Common Crawl web index

Search v2 can merge a small, first-party web index built from Common Crawl into
the **Web** tab. The index is lexical by default; embeddings are optional and
off by default.

## Architecture

```
Cloudflare cron (hourly)
  CDX index ──► cc_queue
  Crowd cc-extract (1–3 WARC records/task)
      node: signed range proxy ──► gzip ──► WARC/HTTP parse ──► parse5 extract
  webhook ──► web_documents + web_fts + R2 text
  (optional) Crowd embed-gemma batch ──► Vectorize web index
```

Browser nodes cannot fetch Common Crawl directly: a cross-origin `Range` request
triggers a CORS preflight, and `data.commoncrawl.org` answers `OPTIONS` with
403. Flaxia therefore exposes `/api/crowd/cc-range`, a short-lived HMAC-signed
range proxy. The node still performs gzip/WARC/HTML extraction.

## Configuration

Pages (`wrangler.toml`):

- `WEB_INDEX_ENABLED=1` — merge `web_documents` into `GET /api/search/v2`.
- `VECTORIZE_WEB` binding (optional) — created separately, never reuse the
  posts index.

Scheduled worker (`wrangler.toml.worker`):

- `CROWD_ORCHESTRATOR_URL`
- `CROWD_API_KEY` / `CROWD_WEBHOOK_SECRET` (secrets)
- `CC_DOMAINS` — comma-separated seed domains; empty disables discovery
- `CC_CRAWL` — optional crawl id; the latest crawl is resolved via collinfo
- `WEB_EMBEDDINGS_ENABLED=1` — submit `embed-gemma` batches (requires the Crowd
  release and a `VECTORIZE_WEB` index)

## Crowd release ordering

The Flaxia node bundle pin intentionally stays at the published version. The
Crowd release that adds `cc-extract` and `embed-gemma` must be published first;
then update `CROWD_NODE_VERSION` and add both capabilities in
`src/lib/crowd-node.ts`. Deploying Flaxia with an unpublished version would make
the `/api/crowd` asset proxy return 404 and stop existing nodes from loading.

## Tables

- `web_documents` — title/excerpt/metadata; `web_fts` is the trigram FTS index.
- `cc_queue` — CDX records awaiting a `cc-extract` task.
- `cc_sources` — domains walked by the hourly discovery job.
- `embed_queue` — documents awaiting an `embed-gemma` batch.

## Still to do

- Client-side EmbeddingGemma 2 (q8 / WebGPU) query vectors and `qv` vector
  search against `VECTORIZE_WEB`.
- Media indexing from R2 (vision/audio encoders).
- Unifying post text embeddings on EmbeddingGemma 2.
