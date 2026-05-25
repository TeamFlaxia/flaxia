let styleInjected = false

function injectToastStyles(): void {
  if (styleInjected) return
  styleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes toast-fade-in-up {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }
    @keyframes toast-fade-out {
      from {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      to {
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
      }
    }
  `
  document.head.appendChild(style)
}

export function showToast(message: string, isError: boolean = false): void {
  injectToastStyles()
  const toast = document.createElement('div')
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: ${isError ? 'var(--danger, #e74c3c)' : 'var(--accent)'};
    color: ${isError ? '#fff' : '#000'};
    padding: 12px 24px;
    border-radius: 4px;
    font-size: 14px;
    z-index: 2000;
    animation: toast-fade-in-up 0.3s ease;
    font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 90vw;
    text-align: center;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `
  toast.textContent = message
  document.body.appendChild(toast)

  setTimeout(() => {
    toast.style.animation = 'toast-fade-out 0.3s ease'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}
