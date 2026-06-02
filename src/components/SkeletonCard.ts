export function createSkeletonCard(): HTMLElement {
  const container = document.createElement('article');
  container.className = 'skeleton-card';
  container.style.cssText = `
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border);
    padding: 1rem;
    animation: skeleton-pulse 1.5s ease-in-out infinite alternate;
  `;

  // Header skeleton
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  `;

  // Avatar skeleton
  const avatar = document.createElement('div');
  avatar.className = 'skeleton-avatar';
  avatar.style.cssText = `
    width: 40px;
    height: 40px;
    background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-secondary) 50%, var(--bg-input) 75%);
    background-size: 200% 100%;
    border-radius: 50%;
    animation: skeleton-shimmer 1.5s infinite;
  `;

  // User info skeleton
  const userInfo = document.createElement('div');
  userInfo.style.cssText = `
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  `;

  const username = document.createElement('div');
  username.style.cssText = `
    width: 120px;
    height: 16px;
    background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-secondary) 50%, var(--bg-input) 75%);
    background-size: 200% 100%;
    border-radius: 4px;
    animation: skeleton-shimmer 1.5s infinite;
  `;

  const timestamp = document.createElement('div');
  timestamp.style.cssText = `
    width: 80px;
    height: 12px;
    background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-secondary) 50%, var(--bg-input) 75%);
    background-size: 200% 100%;
    border-radius: 4px;
    animation: skeleton-shimmer 1.5s infinite;
  `;

  userInfo.appendChild(username);
  userInfo.appendChild(timestamp);

  // Text content skeleton
  const textSkeleton = document.createElement('div');
  textSkeleton.style.cssText = `
    margin-bottom: 1rem;
  `;

  // Create multiple text lines
  for (let i = 0; i < 3; i++) {
    const line = document.createElement('div');
    const width = i === 2 ? '60%' : '100%'; // Last line shorter
    line.style.cssText = `
      width: ${width};
      height: 16px;
      background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-secondary) 50%, var(--bg-input) 75%);
      background-size: 200% 100%;
      border-radius: 4px;
      margin-bottom: 0.5rem;
      animation: skeleton-shimmer 1.5s infinite;
    `;
    textSkeleton.appendChild(line);
  }

  // Media skeleton (16:9 aspect ratio)
  const mediaSkeleton = document.createElement('div');
  mediaSkeleton.className = 'skeleton-media';
  mediaSkeleton.style.cssText = `
    width: 100%;
    padding-bottom: 56.25%; /* 16:9 aspect ratio */
    background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-secondary) 50%, var(--bg-input) 75%);
    background-size: 200% 100%;
    border-radius: 8px;
    margin-bottom: 1rem;
    animation: skeleton-shimmer 1.5s infinite;
    position: relative;
  `;

  // Actions skeleton
  const actions = document.createElement('div');
  actions.style.cssText = `
    display: flex;
    gap: 1rem;
    align-items: center;
  `;

  const createActionButton = () => {
    const button = document.createElement('div');
    button.style.cssText = `
      width: 60px;
      height: 20px;
      background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-secondary) 50%, var(--bg-input) 75%);
      background-size: 200% 100%;
      border-radius: 4px;
      animation: skeleton-shimmer 1.5s infinite;
    `;
    return button;
  };

  actions.appendChild(createActionButton());
  actions.appendChild(createActionButton());
  actions.appendChild(createActionButton());

  // Assemble skeleton
  header.appendChild(avatar);
  header.appendChild(userInfo);

  container.appendChild(header);
  container.appendChild(textSkeleton);
  container.appendChild(mediaSkeleton);
  container.appendChild(actions);

  return container;
}

export function createSkeletonPost(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'skeleton-post';
  container.style.cssText = `
    width: 100%;
    max-width: 600px;
    margin: 0 auto;
  `;

  // Add multiple skeleton cards
  for (let i = 0; i < 3; i++) {
    container.appendChild(createSkeletonCard());
  }

  return container;
}
