import { t } from '../lib/i18n.js';
import type { AdminAnalytics, GameRanking } from '../types/admin-analytics.js';

function createGameRankingTable(
  titleKey: string,
  metricKey: 'play_records' | 'dwell_time',
  games: GameRanking[],
): HTMLElement {
  const section = document.createElement('section');
  section.style.minWidth = '0';
  const table = document.createElement('table');
  table.style.cssText = 'width: 100%; border-collapse: collapse; text-align: left;';
  const caption = document.createElement('caption');
  caption.textContent = t(titleKey);
  caption.style.cssText = 'font-size: 16px; font-weight: 600; text-align: left; padding: 8px 0;';
  table.appendChild(caption);
  const head = table.createTHead().insertRow();
  for (const key of ['rank', 'game', metricKey]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = t(`admin_analytics.${key}`);
    cell.style.cssText = 'padding: 10px; border-bottom: 1px solid #334155;';
    head.appendChild(cell);
  }
  const body = table.createTBody();
  if (games.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.textContent = t('admin_analytics.no_games');
    cell.style.cssText = 'padding: 10px; color: #94a3b8;';
  } else {
    games.forEach((game, index) => {
      const row = body.insertRow();
      const rank = document.createElement('th');
      rank.scope = 'row';
      rank.textContent = String(index + 1);
      rank.style.cssText = 'padding: 10px; border-top: 1px solid #334155;';
      row.appendChild(rank);
      const gameCell = row.insertCell();
      gameCell.style.cssText = 'padding: 10px; border-top: 1px solid #334155;';
      const title = document.createElement('div');
      title.textContent = game.title;
      const creator = document.createElement('small');
      creator.textContent = `@${game.username}`;
      creator.style.color = '#94a3b8';
      gameCell.appendChild(title);
      gameCell.appendChild(creator);
      const metric = row.insertCell();
      metric.textContent =
        metricKey === 'play_records'
          ? game.play_count.toLocaleString()
          : Math.round(game.dwell_ms / 60000).toLocaleString();
      metric.style.cssText = 'padding: 10px; border-top: 1px solid #334155; white-space: nowrap;';
    });
  }
  const wrapper = document.createElement('div');
  wrapper.style.overflowX = 'auto';
  wrapper.appendChild(table);
  section.appendChild(wrapper);
  return section;
}

export function createAdminAnalyticsTab() {
  const element = document.createElement('section');
  element.style.cssText = 'max-width: 1100px; min-width: 0;';
  const title = document.createElement('h2');
  title.textContent = t('admin_analytics.title');
  element.appendChild(title);
  const description = document.createElement('p');
  description.textContent = t('admin_analytics.description');
  description.style.color = '#94a3b8';
  element.appendChild(description);
  const label = document.createElement('label');
  label.textContent = `${t('admin_analytics.period')} `;
  const period = document.createElement('select');
  for (const days of [7, 30, 90]) {
    const option = document.createElement('option');
    option.value = String(days);
    option.textContent = t('admin_analytics.days', { n: days });
    period.appendChild(option);
  }
  period.value = '30';
  label.appendChild(period);
  element.appendChild(label);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = t('admin_analytics.refresh');
  refresh.style.marginLeft = '12px';
  element.appendChild(refresh);
  const content = document.createElement('div');
  content.setAttribute('aria-live', 'polite');
  element.appendChild(content);
  let requestId = 0;

  const load = async () => {
    const id = ++requestId;
    content.textContent = t('admin_analytics.loading');
    refresh.disabled = true;
    try {
      const response = await fetch(`/api/admin/analytics?days=${period.value}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (id !== requestId) return;
      if (response.status === 401 || response.status === 403) {
        content.textContent = t('admin_layout.access_denied');
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch analytics');
      const data = (await response.json()) as AdminAnalytics;
      if (id !== requestId) return;
      content.replaceChildren();
      const updated = document.createElement('p');
      updated.textContent = `${data.start.slice(0, 10)} – ${data.end.slice(0, 10)} (UTC) · ${t('admin_analytics.updated')}: ${new Date(data.end).toLocaleString()}`;
      content.appendChild(updated);
      const cards = document.createElement('div');
      cards.style.cssText =
        'display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0;';
      const values: Array<[string, number]> = [
        ['total_users', data.totals.users],
        ['total_posts', data.totals.posts],
        ['new_users', data.summary.new_users],
        ['posts', data.summary.posts],
        ['freshs', data.summary.freshs],
        ['game_plays', data.summary.game_plays],
        ['active_users', data.summary.active_users],
        ['play_minutes', Math.round(data.summary.dwell_ms / 60000)],
      ];
      for (const [key, value] of values) {
        const card = document.createElement('div');
        card.style.cssText = 'background: #1e293b; padding: 16px; border-radius: 8px;';
        const heading = document.createElement('div');
        heading.textContent = t(`admin_analytics.${key}`);
        const number = document.createElement('strong');
        number.style.fontSize = '24px';
        number.textContent = value.toLocaleString();
        card.appendChild(heading);
        card.appendChild(number);
        cards.appendChild(card);
      }
      content.appendChild(cards);
      const rankings = document.createElement('div');
      rankings.style.cssText =
        'display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin: 20px 0;';
      rankings.appendChild(createGameRankingTable('admin_analytics.top_games', 'play_records', data.top_games));
      rankings.appendChild(createGameRankingTable('admin_analytics.top_dwell_games', 'dwell_time', data.top_dwell_games));
      content.appendChild(rankings);
      const wrapper = document.createElement('div');
      wrapper.style.overflowX = 'auto';
      const table = document.createElement('table');
      table.style.cssText = 'width: 100%; border-collapse: collapse; text-align: right;';
      const caption = document.createElement('caption');
      caption.textContent = t('admin_analytics.daily');
      table.appendChild(caption);
      const head = table.createTHead().insertRow();
      for (const key of ['date', 'new_users', 'posts', 'freshs', 'game_plays', 'active_users', 'play_minutes']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = t(`admin_analytics.${key}`);
        cell.style.padding = '10px';
        head.appendChild(cell);
      }
      const body = table.createTBody();
      for (const day of [...data.daily].reverse()) {
        const row = body.insertRow();
        for (const value of [
          day.day,
          day.new_users,
          day.posts,
          day.freshs,
          day.game_plays,
          day.active_users,
          Math.round(day.dwell_ms / 60000),
        ]) {
          const cell = row.insertCell();
          cell.textContent = typeof value === 'number' ? value.toLocaleString() : value;
          cell.style.cssText = 'padding: 10px; border-top: 1px solid #334155; white-space: nowrap;';
        }
      }
      wrapper.appendChild(table);
      content.appendChild(wrapper);
      const definitions = document.createElement('p');
      definitions.textContent = t('admin_analytics.definitions');
      definitions.style.cssText = 'color: #94a3b8; line-height: 1.7;';
      content.appendChild(definitions);
    } catch {
      if (id === requestId) content.textContent = t('admin_analytics.error');
    } finally {
      if (id === requestId) refresh.disabled = false;
    }
  };
  period.addEventListener('change', load);
  refresh.addEventListener('click', load);
  void load();
  return { getElement: () => element };
}
