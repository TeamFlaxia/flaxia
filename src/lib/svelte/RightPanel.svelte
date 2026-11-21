<script lang="ts">
import { onMount } from 'svelte';
import { formatCount, formatPercentage, relativeBarPercent } from '../format.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import { iconHtml } from '../post/icon-html.ts';
import { commandShortcutLabel } from '../shortcut-label.ts';
import { openShortcutSheet } from '../shortcut-sheet.ts';

interface TrendingTag {
  tag: string;
  count: number;
  percentage: number;
}

interface PopularGame {
  id: string;
  postId: string;
  title: string;
  username: string;
  thumbnailKey?: string;
  freshCount: number;
  impressions: number;
}

let search = $state('');
let tags = $state<TrendingTag[]>([]);
let tagsLoading = $state(true);
let games = $state<PopularGame[]>([]);
let gamesLoading = $state(true);
let showGames = $state(true);

const maxCount = $derived(Math.max(...tags.map((tag) => tag.count), 1));
const shortcut = commandShortcutLabel();

function submitSearch(): void {
  const query = search.trim();
  if (!query) return;
  void navigate(`/search?q=${encodeURIComponent(query)}&type=posts`);
}

function openTag(tag: string): void {
  void navigate(`/explore?tag=${encodeURIComponent(tag)}`);
}

function trendingLabel(percentage: number, count: number): string {
  if (!Number.isFinite(percentage)) return t('right_panel.trending_count', { count });
  return `${t('right_panel.trending_percent', { percentage: formatPercentage(percentage) })} · ${t(
    'right_panel.trending_count',
    { count },
  )}`;
}

async function loadTrendingTags(): Promise<void> {
  try {
    const response = await fetch('/api/tags/trending');
    if (!response.ok) throw new Error('Failed to load trending tags');
    const data = (await response.json()) as { tags?: TrendingTag[] };
    tags = data.tags ?? [];
  } catch (error) {
    console.error('Failed to load trending tags:', error);
    tags = [];
  } finally {
    tagsLoading = false;
  }
}

async function loadPopularGames(): Promise<void> {
  try {
    const response = await fetch('/api/games?trending=true&limit=3');
    if (!response.ok) throw new Error('Failed to load games');
    const data = (await response.json()) as { games?: PopularGame[] };
    games = (data.games ?? []).slice(0, 3);
    showGames = games.length > 0;
  } catch (error) {
    console.error('Failed to load popular games:', error);
    games = [];
    showGames = false;
  } finally {
    gamesLoading = false;
  }
}

onMount(() => {
  void loadTrendingTags();
  void loadPopularGames();
});
</script>

<aside class="right-panel" aria-label="Discover">
  <section class="right-card search-section">
    <div class="search-box">
      <input
        type="text"
        class="search-input"
        placeholder={t('right_panel.search_placeholder')}
        aria-label={t('right_panel.search_placeholder')}
        bind:value={search}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitSearch();
          }
        }}
      />
      <span class="search-icon">{@html iconHtml('search', 15)}</span>
      <kbd class="search-kbd">{shortcut}</kbd>
    </div>
  </section>

  <section class="right-card trending-section">
    <div class="right-card-head">
      <h3 class="right-card-title">
        <span class="right-card-title-icon">{@html iconHtml('hash', 14)}</span>
        <span>{t('right_panel.trending')}</span>
      </h3>
      <a
        class="right-card-more"
        href="/explore"
        onclick={(event) => {
          event.preventDefault();
          void navigate('/explore');
        }}>{t('right_panel.see_all')}</a
      >
    </div>
    <div class="right-card-body trending-list">
      {#if tagsLoading}
        <div class="right-card-status trending-loading">{t('common.loading')}</div>
      {:else if tags.length === 0}
        <div class="right-card-status">{t('right_panel.no_trending')}</div>
      {:else}
        {#each tags as item, index (item.tag)}
          <a
            class="trending-item"
            href={`/explore?tag=${encodeURIComponent(item.tag)}`}
            data-count={item.count}
            onclick={(event) => {
              event.preventDefault();
              openTag(item.tag);
            }}
          >
            <span class="trending-rank">{index + 1}</span>
            <div class="trending-content">
              <div class="trending-hashtag">#{item.tag}</div>
              <div class="trending-bar" aria-hidden="true">
                <span
                  class="trending-bar-fill"
                  style={`width: ${relativeBarPercent(item.count, maxCount)}%`}
                ></span>
              </div>
              <div class="trending-count">{trendingLabel(item.percentage, item.count)}</div>
            </div>
          </a>
        {/each}
      {/if}
    </div>
  </section>

  {#if showGames}
    <section class="right-card games-section">
      <div class="right-card-head">
        <h3 class="right-card-title">
          <span class="right-card-title-icon">{@html iconHtml('game', 14)}</span>
          <span>{t('right_panel.popular_games')}</span>
        </h3>
        <a
          class="right-card-more"
          href="/arcade"
          onclick={(event) => {
            event.preventDefault();
            void navigate('/arcade');
          }}>{t('right_panel.see_all')}</a
        >
      </div>
      <div class="right-card-body games-list">
        {#if gamesLoading}
          <div class="right-card-status">{t('common.loading')}</div>
        {:else}
          {#each games as game (game.postId)}
            <a
              class="game-item"
              href={`/arcade/${game.postId}`}
              onclick={(event) => {
                event.preventDefault();
                void navigate(`/arcade/${game.postId}`);
              }}
            >
              <div class="game-thumb">
                {#if game.thumbnailKey}
                  <img
                    src={nativeApiHref(`/api/thumbnail/${game.postId}`)}
                    alt=""
                    loading="lazy"
                    width="48"
                    height="48"
                  />
                {:else}
                  <span class="game-thumb-fallback">🎮</span>
                {/if}
              </div>
              <div class="game-info">
                <div class="game-title">{game.title}</div>
                <div class="game-meta">
                  <span>{@html iconHtml('impressions', 13)}{formatCount(game.impressions ?? 0)}</span>
                  <span>{@html iconHtml('fresh', 13)}{formatCount(game.freshCount ?? 0)}</span>
                </div>
              </div>
            </a>
          {/each}
        {/if}
      </div>
    </section>
  {/if}

  <section class="right-card help-section">
    <div class="right-card-head">
      <h3 class="right-card-title">
        <span class="right-card-title-icon">{@html iconHtml('help', 14)}</span>
        <span>{t('right_panel.help_title')}</span>
      </h3>
    </div>
    <div class="right-card-body help-list">
      <button type="button" class="help-item" onclick={() => openShortcutSheet()}>
        {@html iconHtml('game', 16)}
        <span class="help-item-text">{t('right_panel.help_shortcuts')}</span>
        {@html iconHtml('chevron-right', 15)}
      </button>
      <button type="button" class="help-item" onclick={() => void navigate('/docs')}>
        {@html iconHtml('guide', 16)}
        <span class="help-item-text">{t('right_panel.help_guide')}</span>
        {@html iconHtml('chevron-right', 15)}
      </button>
      <button type="button" class="help-item" onclick={() => void navigate('/docs/how2join')}>
        {@html iconHtml('users', 16)}
        <span class="help-item-text">{t('right_panel.help_guidelines')}</span>
        {@html iconHtml('chevron-right', 15)}
      </button>
    </div>
  </section>
</aside>
