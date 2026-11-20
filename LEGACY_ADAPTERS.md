# Legacy DOM adapters (shrinking list)

These Svelte entrypoints still mount legacy DOM factories. Entries may only be
**removed** from this list — never added. When a component is rewritten in
Svelte, delete its line in the same PR. `tests/legacy-adapters.test.ts` enforces
this ratchet.

- `src/lib/svelte/AdminView.svelte`: `createAdminAdsTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminAlertsTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminAnalyticsTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminCounterTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminHiddenTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminLayout`
- `src/lib/svelte/AdminView.svelte`: `createAdminUsersTab`
- `src/lib/svelte/ArcadeView.svelte`: `createArcadePage`
- `src/lib/svelte/ArcadeView.svelte`: `createLeftNavHandlers`
- `src/lib/svelte/Composer.svelte`: `createPostComposer`
- `src/lib/svelte/LeftNav.svelte`: `createLeftNav`
- `src/lib/svelte/LegacyShellPage.svelte`: `createLeftNavHandlers`
- `src/lib/svelte/MailView.svelte`: `createLeftNavHandlers`
- `src/lib/svelte/MailView.svelte`: `createMailComposePage`
- `src/lib/svelte/MailView.svelte`: `createMailPage`
- `src/lib/svelte/MailView.svelte`: `createMailSettingsPage`
- `src/lib/svelte/MailView.svelte`: `createMailThreadPage`
- `src/lib/svelte/RightPanel.svelte`: `createRightPanel`
- `src/lib/svelte/ShellLayout.svelte`: `createLeftNavHandlers`
- `src/routes/@[domain]/[username]/+page.svelte`: `createRemoteProfilePage`
- `src/routes/bookmarks/+page.svelte`: `createBookmarksPage`
- `src/routes/bookmarks/+page.svelte`: `createLeftNavHandlers`
- `src/routes/docs/+page.svelte`: `createDocsPage`
- `src/routes/docs/[slug]/+page.svelte`: `createDocsPage`
- `src/routes/download/+page.svelte`: `createDownloadPage`
- `src/routes/explore/+page.svelte`: `createExplorePage`
- `src/routes/home/+page.svelte`: `createLeftNavHandlers`
- `src/routes/home/+page.svelte`: `createTimeline`
- `src/routes/maps/+page.svelte`: `createLeftNavHandlers`
- `src/routes/maps/+page.svelte`: `createMapsPage`
- `src/routes/notifications/+page.svelte`: `createLeftNavHandlers`
- `src/routes/notifications/+page.svelte`: `createNotificationsPage`
- `src/routes/profile/[username]/+page.svelte`: `createProfilePage`
- `src/routes/search/+page.svelte`: `createSearchPage`
- `src/routes/settings/+page.svelte`: `createLeftNavHandlers`
- `src/routes/settings/+page.svelte`: `createSettingsPage`
- `src/routes/thread/[id]/+page.svelte`: `createThreadPage`
- `src/routes/translate/+page.svelte`: `createTranslatePage`
- `src/routes/users/[username]/+page.svelte`: `createProfilePage`
