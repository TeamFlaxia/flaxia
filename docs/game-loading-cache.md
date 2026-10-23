# Game loading cache

Public games continue to execute on the isolated sandbox origin with an opaque
iframe origin. Do not add `allow-same-origin` or restore the retired main-origin
Service Worker ZIP player to enable caching.

The sandbox WVFS route uses the Workers Cache API (`wvfs-responses`) to retain
successful file responses at the serving Cloudflare data center for up to 24
hours. A hit skips extracted-file R2 reads, ZIP range reads, decompression, and
HTML injection. R2 remains the durable fallback across cache eviction and data
centers. The existing payload lookup, R2 head, and current scan check run before
every edge lookup, so blocking a payload also blocks warm entries.

Cache identity includes the sandbox origin, post, resolved version, requested
file, payload key, payload R2 ETag, and compatibility response revision. A new
archive revision therefore cannot hit an older archive's response. Increment
`RESPONSE_REVISION` in `src/lib/wvfs-response-cache.ts` whenever HTML injection
changes; current sandbox CSP is applied after reading the cache.

HTML keeps `no-cache, no-transform` so compatibility and policy updates reach
existing games. Unpinned asset URLs also revalidate because their contents can
change when a new release becomes current. Responses include a weak ETag so
unchanged resources can return 304 without sending the body. Explicitly pinned
asset URLs retain immutable browser caching. Edge cache TTL is independent of
these browser directives. Cache API failures fall back to normal delivery;
errors and responses with cookies are never stored.

The player no longer sends an additional GET to `/index.html` immediately
before navigating the iframe to the same game's entry document.

## Verification

Run the focused tests:

```sh
node --test --experimental-strip-types tests/wvfs-response-cache.test.ts tests/sandbox-response-policy.test.ts tests/wvfs-game-url.test.ts tests/legacy-sandbox-disabled.test.ts
```

After deploying the sandbox worker, inspect a game's requests in browser
DevTools. A first uncached request has `X-WVFS-Cache: MISS`; a repeated request
at the same data center should have `HIT`. HTML should revalidate with
`If-None-Match` and return 304 when unchanged. Repeat after publishing a new
version to check that it gets a new ETag, and block a test payload to confirm
that cached content is no longer served. Compare cold/warm request counts,
transferred bytes, and load timing with the same game and network conditions.
Local mock tests verify skipped R2 reads; they do not measure production latency.

Workers Cache API reference: https://developers.cloudflare.com/workers/runtime-apis/cache/
