# Retired legacy same-origin ZIP sandbox (#79)

The legacy routes `/api/sandbox/sw.js` and `/api/sandbox/post/:postId`
are intentionally disabled and return HTTP **410 Gone**. They formerly
attempted to register a Service Worker on the first-party application
origin and serve user-supplied HTML/JS from its scope. The emitted worker
script had malformed regular expressions and a mismatched registration
scope; repairing only those typos would reactivate a dangerous same-origin
content-execution surface.

The supported game runtime is the **separate sandbox origin** with WVFS
and an iframe that **does not allow same-origin**.

Any future reintroduction of a worker-based ZIP filesystem requires a
dedicated untrusted origin, a verified service-worker scope, restrictive
CSP on every served document, and a full security review.
