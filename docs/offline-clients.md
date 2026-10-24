# Offline native clients

Android/iOS (Capacitor) and Windows/macOS/Linux (Tauri) load the bundled SPA,
including all lazy modules and locale files. Startup no longer requires
flaxia.app to be reachable. A first launch without saved content shows an
explanation rather than waiting indefinitely for the timeline.

After an online visit, native clients can read the saved timeline, previously
opened threads and replies, game listings, and saved image previews/avatars.
Reads try the network first; on a network failure or an eight-second read
deadline they fall back to IndexedDB. HTTP denials and deletions are
authoritative, not reasons to restore old content. The offline banner makes
staleness explicit and provides a reconnect action. Returning online refreshes
the session and timeline without recreating the composer.

## Storage and authentication

- Separate database: flaxia-offline-v1; vault keys and encrypted Studio data
  are untouched.
- Account-scoped keys include the complete feed query/cursor. Login/logout,
  account changes, deletion, and an authoritative /api/me 401 clear snapshots.
  Password reauthentication and SRP upgrades preserve the saved identity and reads.
- Only the display identity (id, username, display name, avatar, badge) is
  retained from /api/me. It is UI metadata, never an authentication credential.
- No vault payloads/keys, notifications, account settings, email, billing,
  admin responses, bearer-authenticated requests, ranges, or no-store
  responses are cached.
- Snapshots expire after seven days. The database retains at most 100 entries
  / 20 MiB, with a 1 MiB per-response limit.

CapacitorHttp and the Tauri HTTP plugin retain HttpOnly sessions in native
cookie jars. No session token is copied to application storage. Tauri HTTP is
scoped to https://flaxia.app/api/*, disables redirects, and exposes no remote
WebView capability. The API trusts only the exact native origins through the
existing CSRF allowlist; the sandbox remains excluded. SameSite=Strict remains.

Tauri's browser WebSocket cannot share the native HTTP cookie jar. Native
clients poll notification badges every 60 seconds while connected; Tauri also
shows newly received notifications. Capacitor still uses FCM for OS push.
Multiplayer obtains an opaque, room-scoped socket ticket over authenticated native
HTTP before opening a browser WebSocket. Tickets expire after 60 seconds; the
server checks the session and room membership again on every socket upgrade.
Session cookies are never returned to JavaScript.

A successful image or notification request does not dismiss the offline banner
while another read still uses saved content; refreshing that read clears its
stale state. A fresh first page also clears saved pagination warnings for the
same feed and filters. Uncached failures do not retain a stale-content warning
after connectivity recovers.

## Online-only features

Posting, likes, follows, authentication, payments, vault operations, uploads,
and multiplayer require a connection. Mutations are never queued or replayed.
Game payloads/runtimes, audio, video, and documents are not downloaded for
offline playback by this change; a saved listing is not a downloaded game.
The browser/PWA service-worker policy is unchanged.

## Verification

Run the offline-client, native-fetch, native-api, and capacitor-security-config
Node test suites, npm run typecheck, npm run lint, and npm run build.
On actual native devices, sign in online, open feeds/images/threads, terminate
the app, enable airplane mode, and reopen it. Verify saved content, cold-start
empty state, mutations failing without replay, reconnect, account switching,
and logout. Native packaging is separate from the web build.
