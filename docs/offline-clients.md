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

## Bookmarked game downloads

Native clients download bookmarked public ZIP and standalone HTML games after
sign-in, on reconnect, and after a successful bookmark action. The Bookmarks
page shows saved/pending/failed counts and a retry button. Offline Bookmarks
and Arcade list completed game downloads, even after a cold start. Removing a
bookmark deletes its download; logout, account changes, deletion and /me 401
clear downloads. Late downloads cannot restore a removed game or old account.

Downloads use a separate IndexedDB database with a 250 MiB expanded-size budget,
25 MiB per archive, 100 MiB expanded per game, and at most 1024 archive entries.
Extraction runs in a disposable worker. Metadata and files commit atomically;
quota, interruption and extraction failures never mark a partial game as saved.
Existing downloads are not silently evicted to make space. Account-scoped game
saves use a separate 64 KiB namespace per game; the game receives only its own
snapshot and never reads application storage.

Publication/scan checks and source revisions use the main-origin public game
descriptor API. Online launches revalidate; revoked games are removed and
changed archives replace the previous revision. During an outage, a completed
download can play for seven days after its last successful verification.
Offline devices cannot learn about revocations until they reconnect or expire.

The bundled bootstrap runs in an opaque iframe without same-origin or native
plugin access. No game code runs in the privileged app document. Native build
preparation disables Capacitor's unsafe legacy Android bridge fallback and
restricts iOS plugin messages to the main frame. A current Android System
WebView is required for native plugin support.

Self-contained classic-script HTML5 games support bundled images, CSS, audio,
fetch/XHR data and WASM via the existing local asset runtime. External assets,
ES modules, nested frames, multi-page navigation and unsupported engines require
the online player; an explicit message explains incompatible local launches.
Flash/SWF is not included in this downloader. Production builds contain no test
harness. CI adds a fixture only to the debug test APK and exercises the actual
download/store/player with a mock account and publication descriptor.

## Online-only features

Posting, likes, follows, authentication, payments, vault operations, uploads,
and multiplayer require a connection. Mutations are never queued or replayed.
Unbookmarked game payloads, external game services, standalone audio/video and
documents are not downloaded for offline playback.
The browser/PWA service-worker policy is unchanged.

## Verification

Run the offline-client, native-fetch, native-api, and capacitor-security-config
Node test suites, npm run typecheck, npm run lint, and npm run build.
On actual native devices, sign in online, open feeds/images/threads, terminate
the app, enable airplane mode, and reopen it. Verify saved content, cold-start
empty state, mutations failing without replay, reconnect, account switching,
and logout. Native packaging is separate from the web build.
