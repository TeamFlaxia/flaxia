# Sandbox Architecture & Security

## Purpose

The sandbox origin (`sandbox.flaxia.app`) executes untrusted user content (ZIP archives, SWF files, HTML5 games) in complete isolation from the main application origin.

## Architecture

### Published games

- The main app loads a game document from `sandbox.flaxia.app` (`/api/wvfs-zip/...`).
- The game iframe is sandboxed without `allow-same-origin`; its response also carries the sandbox Worker CSP.
- Game scripts, external assets, forms, popups, fullscreen and pointer-lock are allowed only in this isolated game context.

### Local ZIP previews

- The main app keeps the selected ZIP local and enforces a 10 MiB transfer limit.
- It opens the trusted `/zip-preview` shell on `sandbox.flaxia.app`, then performs the typed `PREVIEW_INIT` → `ZIP_PREVIEW_READY` → `EXECUTE_ZIP` handshake.
- The ZIP bytes are transferred with an exact sandbox-origin `targetOrigin`; the outer shell is not iframe/CSP-sandboxed because it is a trusted cross-origin bridge endpoint.
- The shell validates the archive, rewrites local HTML/CSS asset URLs to blob URLs, and runs the resulting game document in its own sandboxed iframe. The game iframe never gets `allow-same-origin`.
- Preview bytes are not uploaded. `sandbox/zip-preview-protocol.js` is the shared runtime validator used by both the static shell and `src/lib/bridge.ts`.

The main Pages CSP remains strict (`script-src` has no `unsafe-inline` or `unsafe-eval`). Game-specific allowances are confined to the sandbox Worker origin.

## Game iframe Configuration (NON-NEGOTIABLE)

Untrusted ZIP/SWF/HTML5 game documents always run in a sandboxed iframe. `allow-same-origin` is permanently banned.

```html
<iframe
  src="blob:..."
  sandbox="allow-scripts allow-pointer-lock allow-forms allow-popups"
  allow="fullscreen; web-share"
  referrerpolicy="no-referrer"
/>
```

Only the trusted `/zip-preview` bridge shell and trusted PDF.js viewer use normal cross-origin iframes. Neither contains user-provided HTML; the ZIP shell puts the game in a separate sandboxed child frame.

## CSP Policies

The main Pages policy stays strict: no `unsafe-inline` or `unsafe-eval` in `script-src`. Game compatibility allowances are scoped to the sandbox Worker origin.

### Published game documents (`SANDBOX_CSP`)

The Worker applies a response-header CSP to WVFS game responses. Its `sandbox` directive allows scripts, forms, popups and pointer lock, but never same-origin access. `script-src`/`frame-src` include HTTPS because Arcade games commonly load external libraries and embedded content.

### ZIP preview shell (`ZIP_PREVIEW_CSP`)

The trusted wrapper has no CSP `sandbox` directive so `postMessage` can use exact origins. It validates the ZIP and creates a nested game iframe with the sandbox flags above; no game script executes in the wrapper document.

### PDF viewer (`PDF_VIEWER_CSP`)

The PDF.js shell is a separate trusted cross-origin document with a restrictive `default-src 'none'` policy. PDF bytes are transferred through the typed bridge and parsed as data, never inserted as HTML.

## ZIP Execution

### Simultaneous Execution
Maximum **1 active iframe at a time**. When new content is triggered, the existing iframe is destroyed before creating a new one.

### Display
- In-place expansion within the post card (below text and thumbnail)
- Fixed size: 600×400px
- Fullscreen button in top-right corner

### Path Rewriting
Rewrite relative `src` and `href` references in the root HTML (including script tags), then rewrite relative `url(...)` references in external and inline CSS relative to each CSS file's directory. Preserve external HTTP(S), data, blob and fragment-only references.

### Cleanup
When iframe is closed or replaced, all blob URLs are revoked via `URL.revokeObjectURL()`.

### Error Handling
- ZIP download failed
- ZIP validation failed (with specific reason)
- `index.html` not found
- File type not allowed (with filename)

## ZIP Upload Validation

### Server-side (upload time)
- Content-Length: ≤ 10MB
- Content-Type: `application/zip`

### Client-side (before execution)
- File count: ≤ 255
- Path length: ≤ 255 chars per entry
- Directory depth: ≤ 10 levels
- Total extracted size: ≤ 100MB
- No nested ZIPs
- No symbolic links
- No path traversal segments (`..`) or backslash separators
- No absolute paths (`/` or drive-letter paths)
- `index.html` must exist at root
- Allowed extensions: `.html`, `.css`, `.js`, `.wasm`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.mp4`, `.webm`, `.json`, `.txt`, `.glsl`, `.wgsl`, `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`, `.ico`, `.xml`, `.map`, `.dat`, `.bin`

## R2 Storage Keys

| Pattern | Content |
|---|---|
| `payload/{post_id}` | Post ZIP/SWF payload |
| `zip/{post_id}.zip` | ZIP file |
| `gif/{post_id}.gif` | GIF preview |
| `avatar/{user_id}` | User avatar |
| `ad/payload/{ad_id}` | Ad payload |
| `ad/preview/{ad_id}.{ext}` | Ad preview |

## postMessage Bridge

All cross-origin communication goes through typed messages defined in `src/lib/bridge.ts` and runtime validators in `sandbox/zip-preview-protocol.js`.

The ZIP preview parent checks both `event.source` and the exact `sandbox.flaxia.app` origin, sends `PREVIEW_INIT` to that exact target, and transfers the bounded ZIP only after a matching `ZIP_PREVIEW_READY`. The wrapper replies to the validated parent's exact origin. The game iframe has an opaque origin and is never granted `allow-same-origin`.

For other bridges, validate the expected iframe window as well as its origin before handling typed messages:
