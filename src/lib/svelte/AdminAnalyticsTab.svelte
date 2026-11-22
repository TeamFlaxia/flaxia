<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: used in types/markup
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { AdminAnalytics, GameRanking } from '../../../shared/types/admin-analytics.ts';
import { t } from '../i18n.ts';

let period = $state('30');
let data = $state<AdminAnalytics | null>(null);
let loading = $state(true);
let denied = $state(false);
let error = $state(false);
let requestId = 0;

function metrics(analytics: AdminAnalytics): Array<[string, number]> {
  return [
    ['total_users', analytics.totals.users],
    ['total_posts', analytics.totals.posts],
    ['new_users', analytics.summary.new_users],
    ['posts', analytics.summary.posts],
    ['freshs', analytics.summary.freshs],
    ['game_plays', analytics.summary.game_plays],
    ['active_users', analytics.summary.active_users],
    ['play_minutes', Math.round(analytics.summary.dwell_ms / 60000)],
  ];
}

function rankingValue(game: GameRanking, metric: 'play_records' | 'dwell_time'): string {
  return metric === 'play_records'
    ? game.play_count.toLocaleString()
    : Math.round(game.dwell_ms / 60000).toLocaleString();
}

async function load(): Promise<void> {
  const id = ++requestId;
  loading = true;
  error = false;
  denied = false;
  try {
    const response = await fetch(`/api/admin/analytics?days=${period}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (id !== requestId) return;
    if (response.status === 401 || response.status === 403) {
      denied = true;
      data = null;
      return;
    }
    if (!response.ok) throw new Error('Failed to fetch analytics');
    const payload = (await response.json()) as AdminAnalytics;
    if (id !== requestId) return;
    data = payload;
  } catch {
    if (id === requestId) {
      error = true;
      data = null;
    }
  } finally {
    if (id === requestId) loading = false;
  }
}

onMount(() => {
  void load();
});
</script>

<section class="analytics">
  <h2>{t('admin_analytics.title')}</h2>
  <p class="analytics-description">{t('admin_analytics.description')}</p>
  <label class="analytics-controls">
    {t('admin_analytics.period')}
    <select bind:value={period} onchange={() => void load()}>
      {#each [7, 30, 90] as days (days)}
        <option value={String(days)}>{t('admin_analytics.days', { n: days })}</option>
      {/each}
    </select>
  </label>
  <button type="button" class="analytics-refresh" disabled={loading} onclick={() => void load()}>
    {t('admin_analytics.refresh')}
  </button>

  <div aria-live="polite">
    {#if loading}
      {t('admin_analytics.loading')}
    {:else if denied}
      {t('admin_layout.access_denied')}
    {:else if error}
      {t('admin_analytics.error')}
    {:else if data}
      <p>
        {data.start.slice(0, 10)} – {data.end.slice(0, 10)} (UTC) · {t('admin_analytics.updated')}:
        {new Date(data.end).toLocaleString()}
      </p>

      <div class="analytics-cards">
        {#each metrics(data) as [key, value] (key)}
          <div class="analytics-card">
            <div>{t(`admin_analytics.${key}`)}</div>
            <strong>{value.toLocaleString()}</strong>
          </div>
        {/each}
      </div>

      <div class="analytics-rankings">
        {#each [
          {
            titleKey: 'admin_analytics.top_games',
            metric: 'play_records' as const,
            games: data.top_games,
          },
          {
            titleKey: 'admin_analytics.top_dwell_games',
            metric: 'dwell_time' as const,
            games: data.top_dwell_games,
          },
        ] as ranking (ranking.titleKey)}
          <section class="analytics-ranking">
            <div class="analytics-table-scroll">
              <table>
                <caption>{t(ranking.titleKey)}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin_analytics.rank')}</th>
                    <th scope="col">{t('admin_analytics.game')}</th>
                    <th scope="col">{t(`admin_analytics.${ranking.metric}`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {#if ranking.games.length === 0}
                    <tr>
                      <td colspan="3" class="analytics-empty">{t('admin_analytics.no_games')}</td>
                    </tr>
                  {:else}
                    {#each ranking.games as game, index (game.post_id)}
                      <tr>
                        <th scope="row">{index + 1}</th>
                        <td>
                          <div>{game.title}</div>
                          <small class="analytics-muted">@{game.username}</small>
                        </td>
                        <td class="analytics-nowrap">{rankingValue(game, ranking.metric)}</td>
                      </tr>
                    {/each}
                  {/if}
                </tbody>
              </table>
            </div>
          </section>
        {/each}
      </div>

      <div class="analytics-table-scroll">
        <table class="analytics-daily">
          <caption>{t('admin_analytics.daily')}</caption>
          <thead>
            <tr>
              {#each ['date', 'new_users', 'posts', 'freshs', 'game_plays', 'active_users', 'play_minutes'] as key (key)}
                <th scope="col">{t(`admin_analytics.${key}`)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each [...data.daily].reverse() as day (day.day)}
              <tr>
                <td class="analytics-nowrap">{day.day}</td>
                <td class="analytics-nowrap">{day.new_users.toLocaleString()}</td>
                <td class="analytics-nowrap">{day.posts.toLocaleString()}</td>
                <td class="analytics-nowrap">{day.freshs.toLocaleString()}</td>
                <td class="analytics-nowrap">{day.game_plays.toLocaleString()}</td>
                <td class="analytics-nowrap">{day.active_users.toLocaleString()}</td>
                <td class="analytics-nowrap">{Math.round(day.dwell_ms / 60000).toLocaleString()}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <p class="analytics-definitions">{t('admin_analytics.definitions')}</p>
    {/if}
  </div>
</section>

<style>
  .analytics {
    max-width: 1100px;
    min-width: 0;
  }

  .analytics-description {
    color: #94a3b8;
  }

  .analytics-controls select {
    margin-left: 4px;
  }

  .analytics-refresh {
    margin-left: 12px;
  }

  .analytics-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin: 20px 0;
  }

  .analytics-card {
    background: #1e293b;
    padding: 16px;
    border-radius: 8px;
  }

  .analytics-card strong {
    font-size: 24px;
  }

  .analytics-rankings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 20px;
    margin: 20px 0;
  }

  .analytics-ranking {
    min-width: 0;
  }

  .analytics-table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }

  .analytics-daily {
    text-align: right;
  }

  caption {
    font-size: 16px;
    font-weight: 600;
    text-align: left;
    padding: 8px 0;
  }

  th,
  td {
    padding: 10px;
    border-bottom: 1px solid #334155;
  }

  tbody tr:not(:first-child) th,
  tbody tr:not(:first-child) td {
    border-top: 1px solid #334155;
    border-bottom: 0;
  }

  .analytics-muted,
  .analytics-empty {
    color: #94a3b8;
  }

  .analytics-nowrap {
    white-space: nowrap;
  }

  .analytics-definitions {
    color: #94a3b8;
    line-height: 1.7;
  }
</style>
