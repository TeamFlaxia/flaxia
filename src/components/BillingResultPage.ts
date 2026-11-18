import { html, mount } from '../lib/render/index.ts';

type BillingResultPageProps = {
  success: boolean;
};

export function createBillingResultPage({ success }: BillingResultPageProps) {
  const container = document.createElement('div');
  container.className = success
    ? 'billing-result-page billing-result-page--success'
    : 'billing-result-page billing-result-page--canceled';

  const mounted = mount(
    container,
    () => html`
      <div class="billing-result-card">
        <div class="billing-result-icon" aria-hidden="true">${success ? '✓' : '✕'}</div>
        <h1 class="billing-result-title fx-display">${success ? 'Payment Successful!' : 'Payment Canceled'}</h1>
        <p class="billing-result-message">
          ${
            success
              ? 'Thank you for your purchase! Your plan has been activated. You can now enjoy your premium features.'
              : 'Your payment was canceled. No charges were made.'
          }
        </p>
        <button
          type="button"
          class="billing-result-cta"
          @click=${() => {
            window.history.pushState({}, '', '/');
            window.location.reload();
          }}
        >
          Back to Home
        </button>
      </div>
    `,
  );

  return {
    getElement: () => container,
    destroy: () => mounted.dispose(),
  };
}
