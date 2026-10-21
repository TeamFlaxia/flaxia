export function createFabButton(onClick: () => void, alwaysVisible = false): HTMLElement {
  const btn = document.createElement('button');
  btn.className = `timeline-fab${alwaysVisible ? ' visible' : ''}`;
  btn.textContent = '+';
  btn.addEventListener('click', onClick);
  return btn;
}
