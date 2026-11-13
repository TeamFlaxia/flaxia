type BillingResultPageProps = {
  success: boolean;
};

export function createBillingResultPage({ success }: BillingResultPageProps) {
  const container = document.createElement('div');
  container.className = success
    ? 'billing-result-page billing-result-page--success'
    : 'billing-result-page billing-result-page--canceled';

  const card = document.createElement('div');
  card.className = 'billing-result-card';

  const icon = document.createElement('div');
  icon.className = 'billing-result-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = success ? '✓' : '✕';

  const title = document.createElement('h1');
  title.className = 'billing-result-title fx-display';
  title.textContent = success ? 'Payment Successful!' : 'Payment Canceled';

  const message = document.createElement('p');
  message.className = 'billing-result-message';
  message.textContent = success
    ? 'Thank you for your purchase! Your plan has been activated. You can now enjoy your premium features.'
    : 'Your payment was canceled. No charges were made.';

  const homeBtn = document.createElement('button');
  homeBtn.type = 'button';
  homeBtn.className = 'billing-result-cta';
  homeBtn.textContent = 'Back to Home';
  homeBtn.addEventListener('click', () => {
    window.history.pushState({}, '', '/');
    window.location.reload();
  });

  card.appendChild(icon);
  card.appendChild(title);
  card.appendChild(message);
  card.appendChild(homeBtn);
  container.appendChild(card);

  return {
    getElement: () => container,
    destroy: () => {
      container.remove();
    },
  };
}
