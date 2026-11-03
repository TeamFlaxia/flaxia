# Studio

Studio is a local-first workspace with media composition, a Monaco code editor,
game source editing, and an assistant backed by a local
[better-opencode](https://github.com/TeamFlaxia/better-opencode) server.

## Ownership

Studio lives in its own package: **`@flaxia/studio`**
(`TeamFlaxia/flaxia-studio`). Flaxia keeps only a wrapper and the host services
it already owns:

| Flaxia path | Role |
|---|---|
| `src/components/StudioPage.ts` | configures the host and mounts `@flaxia/studio` |
| `src/lib/studio-host.ts` | vault, ZIP, Flash, media editor, post handoff |
| `src/lib/studio-vault-host.ts` | light host installed at startup for VK rotation |
| `src/lib/studio-vault-bridge.ts` | registers the Studio re-wrap hook |
| `src/lib/router.ts`, `src/main.ts` | `/studio` route and navigation |
| `public/locales/*.json` | `studio.*` translations |

This repository declares the package as a sibling dependency:

```json
"@flaxia/studio": "file:../flaxia-studio"
```

The expected working layout is `projects/flaxia` next to
`projects/flaxia-studio`. CI must use a published version or a git dependency
once the package is released.

## Host boundary

Studio never imports Flaxia source. Everything it needs crosses
`src/host.ts`:

- `t()` — translations
- `vault` — VK access and item encryption (Studio stores encrypted local projects)
- `zip` / `flash` — sandboxed previews
- `media` — the shared image/audio/video editor
- `handoff` — passes local files to the post composer without storage

Vault rotation notifies registered listeners **before** the server accepts the
new envelope, so a failed local re-wrap aborts rotation instead of stranding
encrypted Studio projects.

## better-opencode assistant

The Studio AI panel connects to a local better-opencode server. Nothing is
proxied through Flaxia, and the server URL/password stay in `sessionStorage`
for the current tab.

```bash
opencode serve --hostname 127.0.0.1 --port 4096 \
  --cors http://localhost:3000 --cors https://flaxia.app
opencode service password
```

The panel streams assistant text and tool activity, attaches the active code
buffer as context, and can insert a returned fenced code block into the editor.
Keep the server bound to loopback. The browser talks to it directly, so the
origin must be listed with `--cors` (the desktop app's Tauri origin is allowed
by better-opencode by default).

## Security

- Studio runs on the Flaxia origin and inherits its CSP and session.
- ZIP/SWF content still executes only through the host's sandbox adapters.
- `allow-same-origin` stays banned on all iframes.
- Local projects are AES-GCM encrypted in IndexedDB; the server never receives
  VK, passwords, or project plaintext.
- The OpenCode password is never written to localStorage or sent to Flaxia.
