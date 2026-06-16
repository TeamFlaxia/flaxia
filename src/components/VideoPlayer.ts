export interface VideoPlayerProps {
  gifKey: string;
  postId: string;
}

export function createVideoPlayer(props: VideoPlayerProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'video-player';

  if (!props.gifKey) {
    const fallback = document.createElement('div');
    fallback.className = 'video-player-error';
    fallback.textContent = 'No video';
    container.appendChild(fallback);
    return container;
  }

  const video = document.createElement('video');
  video.className = 'video-player-element';
  video.controls = true;
  video.preload = 'metadata';
  video.setAttribute('playsinline', '');
  video.style.cssText = `
    width: 100%;
    height: auto;
    max-height: 70vh;
    display: block;
    background: #000;
    border-radius: 8px;
  `;

  video.src = `/api/video/${props.gifKey}`;

  video.onerror = () => {
    video.style.display = 'none';
    const fallback = document.createElement('div');
    fallback.className = 'video-player-error';
    fallback.textContent = 'Failed to load video';
    container.appendChild(fallback);
  };

  container.appendChild(video);
  return container;
}
