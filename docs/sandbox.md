# Sandbox Architecture & Security

## Purpose

The sandbox origin (`sandbox.flaxia.app`) executes untrusted user content (ZIP archives, SWF files, HTML5 games) in complete isolation from the main application origin.

## Architecture

```
User clicks thumbnail on PostCard
        │
        ▼
Fetch ZIP from R2 via /api/zip/{post_id}
        │
        ▼
Client-side validation (JSZip):
  - File count ≤ 255
  - No nested ZIPs
  - No path traversal (../)
  - No absolute paths (/)
  - MIME types by extension
  - Total extracted size ≤ 100MB
        │
        ▼
Extract all files, generate blob URLs
        │
        ▼
Rewrite index.html paths → blob URLs
        │
        ▼
Create blob: URL for rewritten HTML
        │
        ▼
Create iframe with sandbox attributes
        │
        ▼
Inject fresh-bridge.js via postMessage handshake
        │
        ▼
Content runs in sandboxed iframe
```

## iframe Configuration (NON-NEGOTIABLE)

```html
<iframe
  src="blob:..."
  sandbox="allow-scripts allow-pointer-lock allow-forms allow-popups"
  allow="fullscreen; web-share"
  referrerpolicy="no-referrer"
  width="600"
  height="400"
/>
```

### Rules
- **`allow-same-origin` is permanently banned** — removing it is a security regression
- No `allow-downloads` without user gesture
- CSP must be set via HTTP response header (not `<meta>`) by the sandbox Worker

## Sandbox CSP

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  connect-src 'none';
  frame-ancestors https://flaxia.com;
```

## ZIP Execution

### Simultaneous Execution
Maximum **1 active iframe at a time**. When new content is triggered, the existing iframe is destroyed before creating a new one.

### Display
- In-place expansion within the post card (below text and thumbnail)
- Fixed size: 600×400px
- Fullscreen button in top-right corner

### Path Rewriting
Rewrite targets in HTML:
- `src="file.js"`, `src="./file.js"`
- `href="style.css"`, `href="./style.css"`

Rewrite targets in CSS:
- `url('path')`, `url("path")`, `url(path)`

Do NOT rewrite:
- `src="https://..."`, `src="http://..."`, `src="data:..."`

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
- No path traversal (`../`)
- No absolute paths (`/`)
- `index.html` must exist at root
- Only allowed extensions: `.html`, `.css`, `.js`, `.wasm`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.mp4`, `.webm`, `.json`, `.txt`, `.glsl`, `.wgsl`

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

All cross-origin communication goes through typed messages defined in `src/lib/bridge.ts`.

Origin validation:
```typescript
window.addEventListener('message', (e) => {
  if (e.origin !== SANDBOX_ORIGIN) return
  // handle message
})
```
