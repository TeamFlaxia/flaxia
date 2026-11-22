<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { getLocale, setLocale, t } from '../i18n.ts';

interface Props {
  currentUser?: { language?: string } | null;
}
let { currentUser = null }: Props = $props();

interface Locale {
  code: string;
  nativeName: string;
}

let locales = $state<Locale[]>([]);
let selected = $state('');
let message = $state('');
let messageTone = $state<'accent' | 'danger'>('accent');
let saving = $state(false);

function applySelection(): void {
  const desired = currentUser?.language || getLocale();
  if (locales.some((locale) => locale.code === desired)) selected = desired;
  else selected = locales[0]?.code ?? '';
}

async function save(): Promise<void> {
  message = '';
  saving = true;
  try {
    const response = await fetch('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: selected }),
    });
    if (response.ok) {
      message = t('settings.language_saved');
      messageTone = 'accent';
      await setLocale(selected);
      location.reload();
    } else {
      const errorData = (await response.json()) as { error?: string };
      message = errorData.error || t('settings.language_save_failed');
      messageTone = 'danger';
    }
  } catch {
    message = t('settings.language_network_error');
    messageTone = 'danger';
  } finally {
    saving = false;
  }
}

onMount(() => {
  fetch('/locales/index.json')
    .then((response) => response.json())
    .then((data) => {
      locales = data as Locale[];
      applySelection();
    })
    .catch(() => {
      locales = [
        { code: 'en', nativeName: 'en' },
        { code: 'ja', nativeName: 'ja' },
      ];
      applySelection();
    });
});
</script>

<h2>{t('settings.language')}</h2>
<select class="settings-input" aria-label={t('settings.language')} bind:value={selected}>
  {#each locales as locale (locale.code)}
    <option value={locale.code}>{locale.nativeName}</option>
  {/each}
</select>
<button class="settings-save" disabled={saving} style:opacity={saving ? '0.6' : undefined} onclick={() => void save()}>
  {t('common.save')}
</button>
<div
  class="settings-status"
  role="status"
  style:color={message ? (messageTone === 'accent' ? 'var(--accent-text)' : 'var(--danger-text)') : undefined}
>
  {message}
</div>
