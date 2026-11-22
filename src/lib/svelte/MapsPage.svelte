<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { onMount } from 'svelte';
import { handleTileFetch, rewriteTileUrl, unwrapTileUrl } from '../maps/cache.js';
import { updateMetaTags } from '../seo-meta.js';
import 'maplibre-gl/dist/maplibre-gl.css';

interface City {
  id: string;
  name: string;
  nameEn: string;
  centerLat: number;
  centerLon: number;
  bbox: [number, number, number, number];
  zoom: number;
  pmtilesPublished: boolean;
  valhallaPublished: boolean;
}

interface WeatherPoint {
  time: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  precipitation: number | null;
  symbol: string | null;
  cloudCover: number | null;
}

interface WeatherPayload {
  lat: number;
  lon: number;
  updatedAt: string;
  points: WeatherPoint[];
}

type WeatherState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: WeatherPayload };

interface StaticTile {
  key: string;
  src: string;
}

const FALLBACK_CITIES: City[] = [
  {
    id: 'tokyo',
    name: '東京',
    nameEn: 'Tokyo',
    centerLat: 35.6762,
    centerLon: 139.6503,
    bbox: [139.25, 35.45, 140.05, 35.85],
    zoom: 13,
    pmtilesPublished: false,
    valhallaPublished: false,
  },
  {
    id: 'osaka',
    name: '大阪',
    nameEn: 'Osaka',
    centerLat: 34.6937,
    centerLon: 135.5023,
    bbox: [135.15, 34.45, 135.85, 34.85],
    zoom: 13,
    pmtilesPublished: false,
    valhallaPublished: false,
  },
  {
    id: 'nagoya',
    name: '名古屋',
    nameEn: 'Nagoya',
    centerLat: 35.1812,
    centerLon: 136.9064,
    bbox: [136.55, 35.0, 137.25, 35.35],
    zoom: 13,
    pmtilesPublished: false,
    valhallaPublished: false,
  },
];

let mapContainer: HTMLDivElement;
let cities: City[] = FALLBACK_CITIES;
let activeCity: City = FALLBACK_CITIES[0];
let lat = FALLBACK_CITIES[0].centerLat;
let lon = FALLBACK_CITIES[0].centerLon;
let zoom = FALLBACK_CITIES[0].zoom;
let located = false;
let currentLocation: { lat: number; lon: number } | null = null;
let currentHeading: number | null = null;
let destroyed = false;
let weatherAbort: AbortController | null = null;
let map: MapLibreMap | null = null;
let marker: MapLibreMarker | null = null;
let maplibre: typeof import('maplibre-gl') | null = null;
let protocolRegistered = false;
let styleUrl = 'https://tiles.openfreemap.org/styles/liberty';
let fallbackReason: 'unsupported' | 'error' | null = $state(null);
let tiles = $state<StaticTile[]>([]);
let weather = $state<WeatherState>({ status: 'loading' });
let cacheState = $state<'live' | 'hit' | 'miss' | 'offline'>('live');
let cacheLabel = $state('ライブ表示');

const fallbackNote = $derived(
  fallbackReason === 'unsupported'
    ? 'このブラウザではWebGLが無効のため、簡易地図を表示しています。'
    : '地図の読み込みに失敗したため、簡易地図を表示しています。',
);
const currentPoint = $derived(weather.status === 'ready' ? weather.data.points?.[0] : undefined);
const weatherTemp = $derived(currentPoint?.temperature != null ? `${Math.round(currentPoint.temperature)}°` : '--');
const weatherMeta = $derived.by(() => {
  if (!currentPoint) return '';
  const hum = currentPoint.humidity != null ? `湿度 ${Math.round(currentPoint.humidity)}%` : '';
  const wind = currentPoint.windSpeed != null ? `風速 ${currentPoint.windSpeed.toFixed(0)}m/s` : '';
  const cloud = currentPoint.cloudCover != null ? `雲量 ${Math.round(currentPoint.cloudCover)}%` : '';
  return [hum, wind, cloud].filter(Boolean).join(' / ');
});
const nextClearPoint = $derived.by(() => {
  if (weather.status !== 'ready') return undefined;
  return (weather.data.points ?? []).slice(1).find((point) => {
    const symbol = (point.symbol ?? '').toLowerCase();
    return symbol.startsWith('clearsky') || symbol.startsWith('fair');
  });
});
const nextClearText = $derived.by(() => {
  if (!nextClearPoint) return '';
  const time = new Date(nextClearPoint.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `次に晴れるのは ${time}（${symbolLabel(nextClearPoint.symbol)}）`;
});

function symbolLabel(symbol: string | null): string {
  if (!symbol) return '';
  const s = symbol.toLowerCase();
  if (s.startsWith('clearsky')) return '晴れ';
  if (s.startsWith('fair')) return '晴れ時々曇り';
  if (s.startsWith('partlycloudy')) return '晴れ時々曇り';
  if (s.startsWith('cloudy')) return '曇り';
  if (s.includes('fog')) return '霧';
  if (s.includes('thunder')) return '雷雨';
  if (s.includes('snow')) return '雪';
  if (s.includes('sleet')) return 'みぞれ';
  if (s.includes('rain')) return '雨';
  return symbol;
}

function showMapFallback(reason: 'unsupported' | 'error', detail?: unknown): void {
  fallbackReason = reason;
  renderStaticMap();
  if (detail) console.warn('Flaxia Maps fallback:', detail);
}

function renderStaticMap(): void {
  const z = Math.max(2, Math.min(14, Math.round(zoom || 12)));
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const centerX = Math.floor(x);
  const centerY = Math.floor(y);
  const next: StaticTile[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tileX = (((centerX + dx) % n) + n) % n;
      const tileY = Math.max(0, Math.min(n - 1, centerY + dy));
      next.push({
        key: `${z}/${tileX}/${tileY}`,
        src: `https://tile.openstreetmap.org/${z}/${tileX}/${tileY}.png`,
      });
    }
  }

  tiles = next;
}

function updateCacheIndicator(kind: 'hit' | 'miss' | 'offline'): void {
  cacheState = kind;
  cacheLabel = kind === 'hit' ? 'キャッシュから表示' : kind === 'miss' ? '取得中…' : 'オフライン表示';
}

function centerOnMap(nextLat: number, nextLon: number, nextZoom: number): void {
  lat = nextLat;
  lon = nextLon;
  zoom = nextZoom;
  if (map) {
    map.flyTo({ center: [lon, lat], zoom, essential: true });
  } else if (fallbackReason) {
    renderStaticMap();
  }
}

function locationMarkerElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'maps-location-marker';
  el.innerHTML =
    '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 2 L20 20 L12 15 L4 20 Z" fill="#2563eb" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>' +
    '</svg>';
  const heading = currentHeading ?? 0;
  el.style.transform = `rotate(${heading}deg)`;
  return el;
}

function placeMarker(nextLat: number, nextLon: number): void {
  if (!map || !maplibre) return;
  marker?.remove();
  marker = new maplibre.Marker({ element: locationMarkerElement(), anchor: 'center' })
    .setLngLat([nextLon, nextLat])
    .addTo(map);
}

async function initMap(): Promise<void> {
  const container = mapContainer;
  if (!container) return;
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) {
    showMapFallback('unsupported');
    return;
  }
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  try {
    const lib = await import('maplibre-gl');
    if (destroyed) return;
    maplibre = lib;
    lib.setWorkerUrl('/maplibre-worker.js');
    if (destroyed) return;
    lib.addProtocol('flaxia-tiles', async (params, abortController) => {
      const url = unwrapTileUrl(params.url);
      if (!url) throw new Error('Unsupported tile URL');
      const data = await handleTileFetch(url, abortController.signal, (kind) => updateCacheIndicator(kind));
      return { data };
    });
    protocolRegistered = true;
    const instance = new lib.Map({
      container,
      style: styleUrl,
      center: [lon, lat],
      zoom,
      attributionControl: { compact: true },
      maxTileCacheZoomLevels: 3,
      // Route vector-tile requests through the on-device cache protocol.
      transformRequest: (url) => {
        const rewritten = rewriteTileUrl(url);
        return rewritten ? { url: rewritten } : undefined;
      },
    });
    map = instance;
    if (located && currentLocation) {
      placeMarker(currentLocation.lat, currentLocation.lon);
    }
    instance.addControl(new lib.NavigationControl({}), 'bottom-right');
    instance.addControl(new lib.ScaleControl(), 'bottom-left');
    instance.on('moveend', () => {
      if (!map || destroyed) return;
      const center = map.getCenter();
      lat = center.lat;
      lon = center.lng;
      zoom = Math.round(map.getZoom());
      void loadWeather();
    });
    let mapLoaded = false;
    instance.once('load', () => {
      mapLoaded = true;
    });
    instance.on('error', (event: { error?: unknown }) => {
      const message = String((event.error as { message?: string })?.message ?? '');
      if (!mapLoaded || message.includes('WebGL') || message.includes('GPU') || message.includes('Worker failed')) {
        showMapFallback(message.includes('WebGL') || message.includes('GPU') ? 'unsupported' : 'error', event.error);
      }
    });
  } catch (error) {
    if (!destroyed) showMapFallback('error', error);
  }
}

async function loadCities(): Promise<void> {
  try {
    const res = await fetch('/api/maps/cities', { credentials: 'include' });
    if (!res.ok || destroyed) return;
    const data = (await res.json()) as { cities: City[]; style?: string };
    if (destroyed) return;
    if (data.style) {
      styleUrl = data.style;
      map?.setStyle(styleUrl);
    }
    if (Array.isArray(data.cities) && data.cities.length > 0) {
      cities = data.cities;
      if (!located) {
        const existing = cities.find((city) => city.id === activeCity.id);
        if (existing) {
          activeCity = existing;
          centerOnMap(existing.centerLat, existing.centerLon, existing.zoom);
        }
      }
    }
  } catch {
    // Fallback to static cities
  }
  void loadWeather();
}

async function locateMe(): Promise<void> {
  let pos: { lat: number; lon: number } | null = null;
  if (navigator.geolocation) {
    pos = await new Promise<{ lat: number; lon: number } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          currentHeading =
            typeof position.coords.heading === 'number' && Number.isFinite(position.coords.heading)
              ? position.coords.heading
              : null;
          resolve({ lat: position.coords.latitude, lon: position.coords.longitude });
        },
        () => resolve(null),
        { timeout: 8000, maximumAge: 300000 },
      );
    });
  }
  if (!pos) {
    try {
      const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()) as { latitude?: number; longitude?: number };
        if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
          pos = { lat: data.latitude, lon: data.longitude };
        }
      }
    } catch {
      // ignore
    }
  }
  if (!pos || destroyed) return;
  lat = pos.lat;
  lon = pos.lon;
  zoom = 13;
  located = true;
  currentLocation = pos;
  centerOnMap(pos.lat, pos.lon, 13);
  placeMarker(pos.lat, pos.lon);
  void loadWeather();
}

async function loadWeather(): Promise<void> {
  weatherAbort?.abort();
  const controller = new AbortController();
  weatherAbort = controller;
  weather = { status: 'loading' };

  try {
    const res = await fetch(`/api/maps/weather?lat=${lat}&lon=${lon}`, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('weather unavailable');
    const data = (await res.json()) as WeatherPayload;
    if (destroyed) return;
    weather = { status: 'ready', data };
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') return;
    if (destroyed) return;
    weather = { status: 'error' };
  }
}

onMount(() => {
  updateMetaTags({
    title: 'Flaxia Maps & Weathers',
    description: 'Flaxia Maps & Weathers',
    url: 'https://flaxia.app/maps',
  });
  void initMap();
  void loadCities();
  void locateMe();

  return () => {
    destroyed = true;
    weatherAbort?.abort();
    if (maplibre && protocolRegistered) {
      try {
        maplibre.removeProtocol('flaxia-tiles');
      } catch {
        // already removed
      }
      protocolRegistered = false;
    }
    map?.remove();
    map = null;
    marker = null;
    maplibre = null;
  };
});
</script>

<div class="maps-page">
  <div class="maps-viewport maps-viewport--libre" data-testid="maps-viewport">
    <div class="maps-libre-container" bind:this={mapContainer} data-testid="maps-libre-container"></div>
    <div class="maps-libre-fallback" hidden={fallbackReason === null} data-testid="maps-libre-fallback">
      <div class="maps-static-tiles" data-testid="maps-static-tiles">
        {#each tiles as tile (tile.key)}
          <img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src={tile.src} />
        {/each}
      </div>
      <span class="maps-static-marker" aria-hidden="true"></span>
      <p class="maps-static-note">{fallbackNote}</p>
    </div>
    <div
      class="maps-cache-indicator"
      data-testid="maps-cache-indicator"
      data-state={cacheState === 'live' ? undefined : cacheState}
    >
      {cacheLabel}
    </div>
    <div class="maps-weather-overlay" data-testid="maps-weather-overlay">
      {#if weather.status === 'loading'}
        …
      {:else if weather.status === 'error'}
        天気を取得できませんでした
      {:else}
        <span class="maps-weather-temp">{weatherTemp}</span>
        <span class="maps-weather-symbol">{symbolLabel(currentPoint?.symbol ?? null)}</span>
        <div class="maps-note">{weatherMeta}</div>
        {#if nextClearPoint}
          <div class="maps-note">{nextClearText}</div>
        {/if}
      {/if}
    </div>
    <div class="maps-attribution">
      © OpenFreeMap © OpenMapTiles Data from OpenStreetMap / © MET Norway / © GeoNames
    </div>
  </div>
</div>
