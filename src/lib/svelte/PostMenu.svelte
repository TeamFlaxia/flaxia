<script lang="ts">
import { showSignInPrompt } from '../../components/SignInPrompt.ts';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';
import { isZipGame } from '../post/zip-game.ts';

export interface PostMenuActions {
  onVersionHistory: () => void;
  onTogglePin?: () => void;
  onCounterNotice: () => void;
  onEdit: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onBlock: () => void;
  onReport: () => void;
}

interface Props {
  isOwnPost: boolean;
  isRemote?: boolean;
  showPinOption?: boolean;
  pinned?: boolean;
  payloadKey?: string | null;
  currentUser?: { username: string; id: string } | null;
  actions: PostMenuActions;
}

let props: Props = $props();

interface Entry {
  key: string;
  label: string;
  danger?: boolean;
  run: () => void;
}

function requireAuth(action: 'block' | 'report', callback: () => void): boolean {
  if (!props.currentUser) {
    showSignInPrompt(
      action,
      () => {
        void navigate('/login');
      },
      () => {
        void navigate('/register');
      },
    );
    return false;
  }
  return true;
}

const entries = $derived.by<Entry[]>(() => {
  const list: Entry[] = [];
  const a = props.actions;
  if (!props.isRemote) {
    list.push({ key: 'version-history', label: t('game.version_history'), run: () => a.onVersionHistory() });
  }
  if (props.isOwnPost) {
    if (props.showPinOption) {
      list.push({
        key: 'pin',
        label: props.pinned ? t('post.menu_unpin') : t('post.menu_pin'),
        run: () => props.actions.onTogglePin?.(),
      });
      list.push({ key: 'counter-notice', label: t('post.menu_counter_notice'), run: () => a.onCounterNotice() });
    }
    list.push({ key: 'edit', label: t('post.menu_edit'), run: () => a.onEdit() });
    if (isZipGame(props.payloadKey ?? null))
      list.push({ key: 'update', label: t('game.update'), run: () => a.onUpdate() });
    list.push({ key: 'delete', label: t('post.menu_delete'), danger: true, run: () => a.onDelete() });
  } else {
    if (!props.isRemote) {
      list.push({
        key: 'block',
        label: t('post.menu_block'),
        danger: true,
        run: () => {
          if (requireAuth('block', a.onBlock)) a.onBlock();
        },
      });
    }
    list.push({
      key: 'report',
      label: t('post.menu_report'),
      run: () => {
        if (requireAuth('report', a.onReport)) a.onReport();
      },
    });
  }
  return list;
});
</script>

<div class="post-menu-dropdown">
  {#each entries as entry (entry.key)}
    <button type="button" class="fx-menu-item" data-danger={entry.danger ? 'true' : undefined} onclick={(e) => { e.stopPropagation(); entry.run(); }}>
      {entry.label}
    </button>
  {/each}
</div>
