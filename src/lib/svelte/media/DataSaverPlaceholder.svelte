<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { t } from '../../i18n.ts';

interface Props {
  label: string;
  onLoad: () => void;
  extraClass?: string;
}

let { label, onLoad, extraClass = '' }: Props = $props();
let disabled = $state(false);

function load(): void {
  if (disabled) return;
  disabled = true;
  onLoad();
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="data-saver-placeholder fx-box {extraClass}"
  style="--fx-ratio: 16 / 9; --fx-min: 0px; background: var(--bg-input); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; color: var(--text-muted); font-size: 0.875rem;"
  onclick={(e) => {
    e.stopPropagation();
    load();
  }}
>
  <div style="text-align: center; padding: 0 1rem;">{t('media.data_saver_placeholder')}</div>
  <button
    type="button"
    {disabled}
    style="background: #22c55e; color: #052e16; border: 1px solid #16a34a; border-radius: 9999px; padding: 0.5rem 1.25rem; cursor: pointer; font-size: 0.875rem; font-weight: 700; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);"
    onclick={(e) => {
      e.stopPropagation();
      load();
    }}>{label}</button
  >
</div>
