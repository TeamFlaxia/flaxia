# Desktop application trust boundary

The desktop application must run **bundled** `dist/index.html` and must never
display the live `https://flaxia.app` website as its privileged application UI.

- All platform Tauri window configs use `index.html` and `create: false`.
  Rust creates the main window with `on_navigation` blocking external origins
  and `on_new_window` denying popups.
- Development uses `http://localhost:3000` (Vite), not the public website.
  Start the API server separately when testing native API calls locally.
- `src/lib/native-api.ts` forwards native-shell API requests to the official
  API origin. This does **not** grant remote web content Tauri IPC permissions.
- `src-tauri/capabilities/default.json` must **not** define
  `context.remote` or allow arbitrary remote origins. All such changes require
  explicit security review.
- A CSP is enabled in the Tauri configuration instead of `csp: null`.
- Links that require a browser should be handled by a trusted system-browser
  integration instead of navigating the app webview.

The static test `tests/tauri-security-config.test.ts` checks these invariants.
