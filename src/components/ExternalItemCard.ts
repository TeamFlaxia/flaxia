import { t } from '../lib/i18n.js';
import type { ExternalItem } from '../types/post.js';

export function createExternalItemCard(item: ExternalItem): { getElement: () => HTMLElement; destroy: () => void } {
  const article = document.createElement('article');
  article.className = 'post-card external-item-card';
  article.dataset.postId = item.id;

  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'external-item-link';
  link.title = t('timeline.external_open');

  const header = document.createElement('div');
  header.className = 'post-card-header';

  const chip = document.createElement('span');
  chip.className = 'external-item-source';
  chip.textContent = item.source_label;

  const date = document.createElement('time');
  date.className = 'post-header-time';
  const published = new Date(item.publish_at);
  date.textContent = Number.isNaN(published.getTime()) ? item.publish_at : published.toLocaleString();
  if (!Number.isNaN(published.getTime())) date.dateTime = published.toISOString();

  header.appendChild(chip);
  header.appendChild(date);

  const title = document.createElement('h3');
  title.className = 'external-item-title';
  title.textContent = item.title;

  link.appendChild(header);
  link.appendChild(title);

  const body = document.createElement('div');
  body.className = 'post-text external-item-body';
  if (item.summary) {
    const summary = document.createElement('p');
    summary.textContent = item.summary;
    body.appendChild(summary);
  }
  if (item.author) {
    const author = document.createElement('p');
    author.className = 'external-item-author';
    author.textContent = item.author;
    body.appendChild(author);
  }
  if (item.tags.length > 0) {
    const tags = document.createElement('p');
    tags.className = 'external-item-tags';
    tags.textContent = item.tags.map((tag) => `#${tag}`).join(' ');
    body.appendChild(tags);
  }

  article.appendChild(link);
  article.appendChild(body);

  return {
    getElement: () => article,
    destroy: () => {
      article.remove();
    },
  };
}
