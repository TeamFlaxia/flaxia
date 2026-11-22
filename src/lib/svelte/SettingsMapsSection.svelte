<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { clearTileCache, getTileCacheStats, requestStoragePersistence } from '../maps/cache.js';

const cities = [
  { id: 'tokyo', name: '東京' },
  { id: 'osaka', name: '大阪' },
  { id: 'nagoya', name: '名古屋' },
];

let cacheStatus = $state('確認中…');
let cityId = $state(cities[0].id);
let packStatus = $state('未取得');

async function refreshCacheStatus(): Promise<void> {
  try {
    const stats = await getTileCacheStats();
    cacheStatus =
      stats.count === 0
        ? 'キャッシュなし（表示すると保存されます）'
        : `${stats.count}件 / ${(stats.bytes / 1024 / 1024).toFixed(1)}MB`;
  } catch {
    cacheStatus = 'キャッシュ状態を取得できませんでした';
  }
}

async function persist(): Promise<void> {
  const ok = await requestStoragePersistence();
  cacheStatus = ok ? '保存が許可されました' : 'このブラウザでは許可できませんでした';
}

async function clearCache(): Promise<void> {
  await clearTileCache();
  await refreshCacheStatus();
}

async function fetchPack(): Promise<void> {
  const packPath = `/api/maps/packs/${encodeURIComponent(cityId)}/pmtiles`;
  try {
    const response = await fetch(packPath);
    if (!response.ok || !response.body) {
      packStatus = `${cityId}: 未配信（ライブ表示中）`;
      return;
    }
    let received = 0;
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > 100 * 1024 * 1024) {
          controller.error(new Error('pack too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const streamed = response.body.pipeThrough(counting);
    const cache = await caches.open('flaxia-maps-packs');
    await cache.put(packPath, new Response(streamed, { headers: { 'Content-Type': 'application/octet-stream' } }));
    packStatus = `${cityId}: 取得済み (${Math.round(received / 1024 / 1024)}MB)`;
  } catch {
    packStatus = `${cityId}: 取得に失敗しました`;
  }
}

onMount(() => {
  void refreshCacheStatus();
});
</script>

<h2>Maps</h2>
<p class="settings-row-label">{cacheStatus}</p>
<div class="settings-choice-list">
  <button type="button" class="settings-radio-card" onclick={() => void persist()}>オフライン保存を許可</button>
  <button type="button" class="settings-radio-card" onclick={() => void clearCache()}>キャッシュ削除</button>
</div>

<h3>都市タイル / City pack</h3>
<select class="settings-radio" bind:value={cityId}>
  {#each cities as city (city.id)}
    <option value={city.id}>{city.name}</option>
  {/each}
</select>
<p class="settings-row-label">{packStatus}</p>
<button type="button" class="settings-radio-card" onclick={() => void fetchPack()}>
  地図タイル取得 / Fetch
</button>
