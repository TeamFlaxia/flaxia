type BillingResultPageProps = {
  success: boolean;
};

export function createBillingResultPage({ success }: BillingResultPageProps) {
  const container = document.createElement('div');
  container.className = 'billing-result-page';
  container.style.cssText = `
    max-width: 500px;
    margin: 4rem auto;
    padding: 2rem;
    text-align: center;
  `;

  const icon = document.createElement('div');
  icon.style.cssText = `
    font-size: 4rem;
    margin-bottom: 1rem;
  `;
  icon.textContent = success ? '🎉' : '😔';

  const title = document.createElement('h1');
  title.style.cssText = `
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 0.75rem;
  `;
  title.textContent = success ? 'Payment Successful!' : 'Payment Canceled';

  const message = document.createElement('p');
  message.style.cssText = `
    font-size: 1rem;
    color: var(--text-secondary);
    margin-bottom: 2rem;
    line-height: 1.6;
  `;
  message.textContent = success
    ? 'Thank you for your purchase! Your plan has been activated. You can now enjoy your premium features.'
    : 'Your payment was canceled. No charges were made.';

  const homeBtn = document.createElement('button');
  homeBtn.textContent = 'Back to Home';
  homeBtn.style.cssText = `
    padding: 0.75rem 2rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: white;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
    transition: opacity 0.2s;
  `;
  homeBtn.addEventListener('mouseenter', () => {
    homeBtn.style.opacity = '0.85';
  });
  homeBtn.addEventListener('mouseleave', () => {
    homeBtn.style.opacity = '1';
  });
  homeBtn.addEventListener('click', () => {
    window.history.pushState({}, '', '/');
    window.location.reload();
  });

  container.appendChild(icon);
  container.appendChild(title);
  container.appendChild(message);
  container.appendChild(homeBtn);

  return {
    getElement: () => container,
    destroy: () => {
      container.remove();
    },
  };
}
