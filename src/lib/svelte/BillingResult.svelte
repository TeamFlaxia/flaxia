<script lang="ts">
import { navigate } from '../navigation.ts';
import '../../styles/index.css';

// biome-ignore lint/correctness/noUnusedVariables: Svelte 5 prop used in markup
let { success }: { success: boolean } = $props();

// biome-ignore lint/correctness/noUnusedVariables: used as the onclick handler
function backHome() {
  void navigate('/');
  window.location.reload();
}
</script>

<div class="billing-result-page {success ? 'billing-result-page--success' : 'billing-result-page--canceled'}">
  <div class="billing-result-card">
    <div class="billing-result-icon" aria-hidden="true">{success ? '✓' : '✕'}</div>
    <h1 class="billing-result-title fx-display">{success ? 'Payment Successful!' : 'Payment Canceled'}</h1>
    <p class="billing-result-message">
      {success
        ? 'Thank you for your purchase! Your plan has been activated. You can now enjoy your premium features.'
        : 'Your payment was canceled. No charges were made.'}
    </p>
    <button type="button" class="billing-result-cta" onclick={backHome}>Back to Home</button>
  </div>
</div>

