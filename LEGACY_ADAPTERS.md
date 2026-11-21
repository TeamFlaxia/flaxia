# Legacy DOM adapters (shrinking list)

These Svelte entrypoints still mount legacy DOM factories. Entries may only be
**removed** from this list — never added. When a component is rewritten in
Svelte, delete its line in the same PR. `tests/legacy-adapters.test.ts` enforces
this ratchet.

- `src/lib/svelte/SettingsPage.svelte`: `createSettingsPage`
- `src/lib/svelte/AdminView.svelte`: `createAdminAdsTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminAlertsTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminAnalyticsTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminCounterTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminHiddenTab`
- `src/lib/svelte/AdminView.svelte`: `createAdminLayout`
- `src/lib/svelte/AdminView.svelte`: `createAdminUsersTab`
- `src/lib/svelte/LeftNav.svelte`: `createLeftNav`
- `src/lib/svelte/MailView.svelte`: `createMailComposePage`
- `src/lib/svelte/MailView.svelte`: `createMailSettingsPage`
- `src/lib/svelte/MailView.svelte`: `createMailThreadPage`
- `src/lib/svelte/RightPanel.svelte`: `createRightPanel`
- `src/routes/maps/+page.svelte`: `createMapsPage`
