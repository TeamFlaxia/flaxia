export function createSkeletonCard(): HTMLElement {
  const container = document.createElement('article');
  container.className = 'skeleton-card';
  // Decorative loading placeholder: hide it from assistive tech.
  container.setAttribute('aria-hidden', 'true');

  const header = document.createElement('div');
  header.className = 'skeleton-header';

  const avatar = document.createElement('div');
  avatar.className = 'skeleton-avatar';

  const userInfo = document.createElement('div');
  userInfo.className = 'skeleton-user';

  const username = document.createElement('div');
  username.className = 'skeleton-line skeleton-line--name';

  const timestamp = document.createElement('div');
  timestamp.className = 'skeleton-line skeleton-line--time';

  userInfo.appendChild(username);
  userInfo.appendChild(timestamp);

  const textSkeleton = document.createElement('div');
  textSkeleton.className = 'skeleton-text';
  for (let i = 0; i < 3; i++) {
    const line = document.createElement('div');
    line.className = i === 2 ? 'skeleton-line skeleton-line--short' : 'skeleton-line';
    textSkeleton.appendChild(line);
  }

  const mediaSkeleton = document.createElement('div');
  mediaSkeleton.className = 'skeleton-media';

  const actions = document.createElement('div');
  actions.className = 'skeleton-actions';
  for (let i = 0; i < 3; i++) {
    const action = document.createElement('div');
    action.className = 'skeleton-action';
    actions.appendChild(action);
  }

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
  for (let i = 0; i < 3; i++) {
    container.appendChild(createSkeletonCard());
  }
  return container;
}
