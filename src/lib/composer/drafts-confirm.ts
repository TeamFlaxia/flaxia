// Confirm dialog adapter: the legacy modal factory must not be called from
// Svelte markup (LEGACY_ADAPTERS ratchet).
import { createConfirmDialog } from '../confirm-dialog.ts';
import { t } from '../i18n.ts';

export function confirmDeleteAllDrafts(): Promise<boolean> {
  return createConfirmDialog(t('composer.draft_delete_all_confirm'), { destructive: true });
}
