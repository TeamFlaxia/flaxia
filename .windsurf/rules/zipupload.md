---
trigger: model_decision
description: When ZIP Upload Development
---

# ZIP Upload Specification

## 1. Upload Flow

Follows the existing 3-step pattern used for images and audio:

Step 1: POST /api/posts/prepare with contentType: application/zip
Returns: postId, zipUploadUrl, zipKey

Step 2: PUT /api/upload/zip/{postId}.zip
Uploads ZIP binary directly to R2.

Step 3: POST /api/posts/commit
Updates DB record from pending to published.

## 2. Server-side Validation

Checked at upload time (Step 2):

- Content-Length must be 10MB or less
- Content-Type must be application/zip

No extraction is performed on the server. Cloudflare Workers memory constraints make full extraction impractical, and client-side validation covers the rest.

## 3. Client-side Validation

Performed using JSZip after download, before iframe is created. If any check fails, execution is aborted and an error is shown to the user.

- File count: 255 or fewer
- Path length: 255 characters or fewer per entry
- Directory depth: 10 levels or fewer
- Total extracted size: 100MB or less
- Nested ZIP files: forbidden
- Symbolic links: forbidden
- Path traversal: forbidden (any path containing ../)
- Absolute paths: forbidden (any path starting with /)
- index.html: must exist at the root level
- MIME types: fixed by extension (see section 5)

## 4. UI

Uses the same file attachment button as images and audio. accept=".zip" is set on the file input. The composer displays the filename and file size as a preview after selection. No other UI changes are needed.

## 5. Allowed File Types

Only the following extensions are permitted inside the ZIP. Files with any other extension are rejected during client-side validation.

- .html → text/html
- .css → text/css
- .js → text/javascript
- .wasm → application/wasm
- .png → image/png
- .jpg → image/jpeg
- .jpeg → image/jpeg
- .gif → image/gif
- .webp → image/webp
- .svg → image/svg+xml
- .mp3 → audio/mpeg
- .wav → audio/wav
- .ogg → audio/ogg
- .mp4 → video/mp4
- .webm → video/webm
- .json → application/json
- .txt → text/plain
- .glsl → text/plain
- .wgsl → text/plain

## 6. R2 Storage Key

zip/{post_id}.zip

## 7. DB Column

Uses the existing payload_key column in the posts table. No schema migration required.