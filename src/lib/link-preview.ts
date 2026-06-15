export interface LinkPreviewData {
  title: string;
  description: string;
  image: string;
  siteName: string;
  url: string;
  type?: string;
  video?: {
    url?: string;
    secureUrl?: string;
    type?: string;
    width?: number;
    height?: number;
  };
}

export function getYouTubeId(url: string): string | null {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/i;
  const match = url.match(regExp);
  return match && match[2].length >= 11 ? match[2] : null;
}

export function createLinkPreviewCard(data: LinkPreviewData): HTMLElement {
  const card = document.createElement('a');
  card.href = data.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.className = 'link-preview-card';

  card.style.cssText = `
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-top: 0.75rem;
    margin-bottom: 1rem;
    text-decoration: none;
    color: inherit;
    background: var(--bg-secondary);
    transition: background 0.2s, border-color 0.2s;
  `;

  card.addEventListener('mouseenter', () => {
    card.style.background = 'var(--bg-input)';
    card.style.borderColor = 'var(--accent)';
  });
  card.addEventListener('mouseleave', () => {
    card.style.background = 'var(--bg-secondary)';
    card.style.borderColor = 'var(--border)';
  });

  card.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const youtubeId = getYouTubeId(data.url);
  const thumbnailSrc = youtubeId && !data.image ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : data.image;

  {
    const imgContainer = document.createElement('div');
    imgContainer.className = 'link-preview-image-container';

    if (thumbnailSrc) {
      imgContainer.style.cssText = `
        position: relative;
        min-width: 0;
        padding-bottom: 52.25%;
        background: var(--bg-input);
        overflow: hidden;
        border-bottom: 1px solid var(--border);
      `;

      const img = document.createElement('img');
      img.src = thumbnailSrc;
      img.loading = 'lazy';
      img.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      `;
      img.onerror = () => {
        imgContainer.innerHTML = '';
        imgContainer.style.cssText = `
          position: relative;
          min-width: 0;
          padding-bottom: 25%;
          background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 50%, rgba(236, 72, 153, 0.15) 100%), var(--bg-input);
          overflow: hidden;
          border-bottom: 1px solid var(--border);
        `;
        const fallbackIcon = document.createElement('div');
        fallbackIcon.style.cssText = `
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 2rem;
          opacity: 0.65;
          filter: drop-shadow(0 0 12px rgba(168, 85, 247, 0.4));
          user-select: none;
        `;
        fallbackIcon.textContent = '\u{1F310}';
        imgContainer.appendChild(fallbackIcon);
      };
      imgContainer.appendChild(img);

      if (youtubeId) {
        const playBadge = document.createElement('div');
        playBadge.style.cssText = `
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: rgba(239, 68, 68, 0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 1.4rem;
          box-shadow: 0 0 16px rgba(239, 68, 68, 0.5);
          pointer-events: none;
          transition: transform 0.2s, background 0.2s;
        `;
        playBadge.innerHTML = '<span style="margin-left: 3px;">\u25B6</span>';
        imgContainer.appendChild(playBadge);

        imgContainer.addEventListener('mouseenter', () => {
          playBadge.style.transform = 'translate(-50%, -50%) scale(1.1)';
          playBadge.style.background = 'rgba(220, 38, 38, 1)';
        });
        imgContainer.addEventListener('mouseleave', () => {
          playBadge.style.transform = 'translate(-50%, -50%) scale(1)';
          playBadge.style.background = 'rgba(239, 68, 68, 0.9)';
        });

        imgContainer.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const iframe = document.createElement('iframe');
          iframe.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&mute=1`;
          iframe.title = data.title || 'YouTube video';
          iframe.frameBorder = '0';
          iframe.allow =
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
          iframe.allowFullscreen = true;
          iframe.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            border: none;
          `;
          imgContainer.innerHTML = '';
          imgContainer.appendChild(iframe);
        });
      }
    } else {
      imgContainer.style.cssText = `
        position: relative;
        min-width: 0;
        padding-bottom: 25%;
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 50%, rgba(236, 72, 153, 0.15) 100%), var(--bg-input);
        overflow: hidden;
        border-bottom: 1px solid var(--border);
      `;

      const placeholderSymbol = document.createElement('div');
      placeholderSymbol.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 2rem;
        opacity: 0.65;
        filter: drop-shadow(0 0 12px rgba(168, 85, 247, 0.4));
        user-select: none;
      `;
      placeholderSymbol.textContent = '\u{1F310}';
      imgContainer.appendChild(placeholderSymbol);
    }
    card.appendChild(imgContainer);
  }

  const textContainer = document.createElement('div');
  textContainer.className = 'link-preview-text';
  textContainer.style.cssText = `
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    word-break: break-word;
  `;

  const siteName = document.createElement('div');
  siteName.className = 'link-preview-site-name';
  siteName.style.cssText = `
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: monospace;
    text-transform: lowercase;
  `;
  siteName.textContent = data.siteName;
  textContainer.appendChild(siteName);

  if (data.title) {
    const title = document.createElement('div');
    title.className = 'link-preview-title';
    title.style.cssText = `
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-primary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    `;
    title.textContent = data.title;
    textContainer.appendChild(title);
  }

  if (data.description) {
    const desc = document.createElement('div');
    desc.className = 'link-preview-description';
    desc.style.cssText = `
      font-size: 0.825rem;
      color: var(--text-muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.4;
    `;
    desc.textContent = data.description;
    textContainer.appendChild(desc);
  }

  card.appendChild(textContainer);
  return card;
}

export function loadLinkPreview(text: string, container: HTMLElement): void {
  if (!text) return;

  const urlRegex = /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/i;
  const match = text.match(urlRegex);
  if (!match) return;

  let url = match[1];
  if (url.toLowerCase().startsWith('www.')) {
    url = 'https://' + url;
  }

  if (
    url.includes('/api/images/') ||
    url.includes('/api/audio/') ||
    url.includes('/api/zip/') ||
    url.includes('/api/swf/') ||
    url.includes('/api/thumbnail/') ||
    url.includes('/api/wvfs-zip/')
  ) {
    return;
  }

  fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
    .then(async (res) => {
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error((errorData as { error?: string })?.error || `Preview fetch failed (${res.status})`);
      }
      return res.json();
    })
    .then((data: unknown) => {
      const d = data as LinkPreviewData;
      if (d && d.url) {
        const card = createLinkPreviewCard(d);
        container.appendChild(card);
      }
    })
    .catch((err) => {
      console.warn('Failed to load link preview:', err);
    });
}
