import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { t } from '../lib/i18n.js';
import { getTileCacheStats, handleTileFetch, rewriteTileUrl, unwrapTileUrl } from '../lib/maps/cache.js';
import { createPageHeader } from '../lib/page-header.js';
import { updateMetaTags } from '../lib/seo-meta.js';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface MapsPageProps {
  getCities?: () => Promise<
    Array<{
      id: string;
      name: string;
      nameEn: string;
      centerLat: number;
      centerLon: number;
      bbox: [number, number, number, number];
      zoom: number;
      pmtilesPublished: boolean;
      valhallaPublished: boolean;
    }>
  >;
}

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

interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: string;
  cityId: string;
}

interface WeatherPoint {
  time: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  precipitation: number | null;
  symbol: string | null;
}

interface WeatherPayload {
  lat: number;
  lon: number;
  updatedAt: string;
  points: WeatherPoint[];
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

function areaSlug(lat: number, lon: number): string {
  const la = Math.round(lat * 100);
  const lo = Math.round(lon * 100);
  return `area-${lo < 0 ? `n${-lo}` : lo}-${la < 0 ? `n${-la}` : la}`;
}

function normalizeSlug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(s) ? s : areaSlug(0, 0);
}

export class MapsPage {
  private element: HTMLElement;
  private cities: City[] = FALLBACK_CITIES;
  private activeCity: City = FALLBACK_CITIES[0];
  private lat: number = FALLBACK_CITIES[0].centerLat;
  private lon: number = FALLBACK_CITIES[0].centerLon;
  private zoom: number = FALLBACK_CITIES[0].zoom;
  private destroyed = false;
  private weatherAbort: AbortController | null = null;
  private searchAbort: AbortController | null = null;
  private searchSeq = 0;
  private routeAbort: AbortController | null = null;
  private map: MapLibreMap | null = null;
  private marker: MapLibreMarker | null = null;
  private maplibre: typeof import('maplibre-gl') | null = null;
  private protocolRegistered = false;
  private tileHits = 0;
  private tileMisses = 0;
  private styleUrl = 'https://tiles.openfreemap.org/styles/liberty';
  private packAbort: AbortController | null = null;
  private mapFallbackReason: 'unsupported' | 'error' | null = null;

  constructor(_props: MapsPageProps = {}) {
    updateMetaTags({
      title: 'Flaxia Maps & Weathers',
      description: 'Flaxia Maps & Weathers',
      url: 'https://flaxia.app/maps',
    });
    this.element = this.createElement();
    this.attachEvents();
    this.loadCities();
    void this.initMap();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.destroyed = true;
    this.weatherAbort?.abort();
    this.searchAbort?.abort();
    this.routeAbort?.abort();
    this.packAbort?.abort();
    if (this.maplibre && this.protocolRegistered) {
      try {
        this.maplibre.removeProtocol('flaxia-tiles');
      } catch {
        // already removed
      }
      this.protocolRegistered = false;
    }
    this.map?.remove();
    this.map = null;
    this.marker = null;
    this.maplibre = null;
    this.element.remove();
  }

  private createElement(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'maps-page';

    const header = createPageHeader({ title: t('nav.maps') || 'Maps', subtitle: 'Maps & Weathers' });
    root.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'maps-controls';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'maps-search';
    const searchInput = document.createElement('input');
    searchInput.className = 'maps-search-input';
    searchInput.type = 'search';
    searchInput.placeholder = '地名を検索（全世界対応）';
    searchInput.dataset.testid = 'maps-search';
    const suggestions = document.createElement('div');
    suggestions.className = 'maps-suggestions';
    suggestions.hidden = true;
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(suggestions);
    controls.appendChild(searchWrap);
    root.appendChild(controls);

    const viewport = document.createElement('div');
    viewport.className = 'maps-viewport maps-viewport--libre';
    viewport.dataset.testid = 'maps-viewport';
    const mapContainer = document.createElement('div');
    mapContainer.className = 'maps-libre-container';
    mapContainer.dataset.testid = 'maps-libre-container';
    viewport.appendChild(mapContainer);
    const mapError = document.createElement('div');
    mapError.className = 'maps-libre-fallback';
    mapError.hidden = true;
    mapError.dataset.testid = 'maps-libre-fallback';
    const fallbackNote = document.createElement('p');
    fallbackNote.className = 'maps-static-note';
    fallbackNote.textContent = '地図を表示できませんでした。ブラウザのWebGLを有効にしてください。';
    const fallbackTiles = document.createElement('div');
    fallbackTiles.className = 'maps-static-tiles';
    fallbackTiles.dataset.testid = 'maps-static-tiles';
    const fallbackMarker = document.createElement('span');
    fallbackMarker.className = 'maps-static-marker';
    fallbackMarker.setAttribute('aria-hidden', 'true');
    mapError.appendChild(fallbackTiles);
    mapError.appendChild(fallbackMarker);
    mapError.appendChild(fallbackNote);
    viewport.appendChild(mapError);
    const cacheIndicator = document.createElement('div');
    cacheIndicator.className = 'maps-cache-indicator';
    cacheIndicator.dataset.testid = 'maps-cache-indicator';
    cacheIndicator.textContent = 'ライブ表示';
    viewport.appendChild(cacheIndicator);
    const attribution = document.createElement('div');
    attribution.className = 'maps-attribution';
    attribution.textContent = '© OpenFreeMap © OpenMapTiles Data from OpenStreetMap / © MET Norway / © GeoNames';
    viewport.appendChild(attribution);
    root.appendChild(viewport);
    return root;
  }

  private attachEvents(): void {
    const searchInput = this.element.querySelector('.maps-search-input') as HTMLInputElement | null;
    const suggestions = this.element.querySelector('.maps-suggestions') as HTMLElement | null;
    if (searchInput && suggestions) {
      let timer = 0;
      searchInput.addEventListener('input', () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void this.onSearchInput(searchInput.value, suggestions);
        }, 300);
      });
    }
  }

  /**
   * MapLibre needs WebGL2. Some desktop/WebView builds ship with WebGL
   * disabled, so draw a lightweight OSM raster fallback instead of leaving a
   * blank viewport. The fallback is non-interactive but still shows the current
   * city/search result and does not need a GPU.
   */
  private showMapFallback(reason: 'unsupported' | 'error', detail?: unknown): void {
    const fallback = this.element.querySelector('.maps-libre-fallback') as HTMLElement | null;
    if (!fallback) return;
    this.mapFallbackReason = reason;
    fallback.hidden = false;
    const note = fallback.querySelector('.maps-static-note');
    if (note) {
      note.textContent =
        reason === 'unsupported'
          ? 'このブラウザではWebGLが無効のため、簡易地図を表示しています。'
          : '地図の読み込みに失敗したため、簡易地図を表示しています。';
    }
    this.renderStaticMap();
    if (detail) console.warn('Flaxia Maps fallback:', detail);
  }

  private renderStaticMap(): void {
    const grid = this.element.querySelector('.maps-static-tiles') as HTMLElement | null;
    if (!grid) return;
    const z = Math.max(2, Math.min(14, Math.round(this.zoom || 12)));
    const n = 2 ** z;
    const latRad = (this.lat * Math.PI) / 180;
    const x = ((this.lon + 180) / 360) * n;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const centerX = Math.floor(x);
    const centerY = Math.floor(y);
    grid.innerHTML = '';
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.src = `https://tile.openstreetmap.org/${z}/${(((centerX + dx) % n) + n) % n}/${Math.max(0, Math.min(n - 1, centerY + dy))}.png`;
        grid.appendChild(img);
      }
    }
  }

  private async initMap(): Promise<void> {
    const container = this.element.querySelector('.maps-libre-container') as HTMLElement | null;
    if (!container) return;
    const probe = document.createElement('canvas');
    const probeGl = probe.getContext('webgl2');
    if (!probeGl) {
      this.showMapFallback('unsupported');
      return;
    }
    probeGl.getExtension('WEBGL_lose_context')?.loseContext();
    try {
      const maplibre = await import('maplibre-gl');
      if (this.destroyed) return;
      this.maplibre = maplibre;
      maplibre.setWorkerUrl('/maplibre-worker.js');
      if (this.destroyed) return;
      const styleUrl: string = this.styleUrl;
      maplibre.addProtocol('flaxia-tiles', async (params, abortController) => {
        const url = unwrapTileUrl(params.url);
        if (!url) throw new Error('Unsupported tile URL');
        const data = await handleTileFetch(url, abortController.signal, (kind) => {
          if (kind === 'hit') this.tileHits += 1;
          if (kind === 'miss') this.tileMisses += 1;
          this.updateCacheIndicator(kind);
        });
        return { data };
      });
      this.protocolRegistered = true;
      const map = new maplibre.Map({
        container,
        style: styleUrl,
        center: [this.lon, this.lat],
        zoom: this.zoom,
        attributionControl: { compact: true },
        maxTileCacheZoomLevels: 3,
        // Route vector-tile requests through the on-device cache protocol.
        transformRequest: (url) => {
          const rewritten = rewriteTileUrl(url);
          return rewritten ? { url: rewritten } : undefined;
        },
      });
      this.map = map;
      map.addControl(new maplibre.NavigationControl({}), 'bottom-right');
      map.addControl(new maplibre.ScaleControl(), 'bottom-left');
      map.on('moveend', () => {
        if (!this.map || this.destroyed) return;
        const center = this.map.getCenter();
        this.lat = center.lat;
        this.lon = center.lng;
        this.zoom = Math.round(this.map.getZoom());
        this.loadWeather();
      });
      let mapLoaded = false;
      map.once('load', () => {
        mapLoaded = true;
      });
      map.on('error', (e: { error?: unknown }) => {
        const message = String((e.error as { message?: string })?.message ?? '');
        if (!mapLoaded || message.includes('WebGL') || message.includes('GPU') || message.includes('Worker failed')) {
          this.showMapFallback(message.includes('WebGL') || message.includes('GPU') ? 'unsupported' : 'error', e.error);
        }
      });
      await this.refreshCacheStatus();
    } catch (error) {
      if (!this.destroyed) this.showMapFallback('error', error);
    }
  }

  private centerOnMap(lat: number, lon: number, zoom: number): void {
    this.lat = lat;
    this.lon = lon;
    this.zoom = zoom;
    if (this.map) {
      this.map.flyTo({ center: [lon, lat], zoom, essential: true });
    } else if (this.mapFallbackReason) {
      this.renderStaticMap();
    }
  }

  private placeMarker(lat: number, lon: number): void {
    if (!this.map || !this.maplibre) return;
    this.marker?.remove();
    this.marker = new this.maplibre.Marker({ color: '#e11d48' }).setLngLat([lon, lat]).addTo(this.map);
  }

  private updateCacheIndicator(kind: 'hit' | 'miss' | 'offline'): void {
    const el = this.element.querySelector('[data-testid="maps-cache-indicator"]') as HTMLElement | null;
    if (!el) return;
    el.textContent = kind === 'hit' ? 'キャッシュから表示' : kind === 'miss' ? '取得中…' : 'オフライン表示';
    el.dataset.state = kind;
  }

  private async refreshCacheStatus(): Promise<void> {
    const status = this.element.querySelector('[data-testid="maps-cache-status"]');
    const detail = this.element.querySelector('[data-testid="maps-cache-detail"]');
    try {
      const stats = await getTileCacheStats();
      const estimate = await navigator.storage?.estimate?.();
      const usage = stats.bytes;
      const quota = estimate?.quota ?? 0;
      if (status) {
        status.textContent =
          stats.count === 0
            ? 'キャッシュなし（表示すると保存されます）'
            : `${stats.count}件 / ${(usage / 1024 / 1024).toFixed(1)}MB`;
      }
      if (detail) {
        const quotaText =
          quota > 0
            ? `端末の空き容量のうち ${(usage / quota) * 100 >= 1 ? ((usage / quota) * 100).toFixed(1) : '<1'}%`
            : '';
        const session = `今回の表示: キャッシュ ${this.tileHits}件 / 取得 ${this.tileMisses}件`;
        detail.textContent = [quotaText, session, '表示したタイルは端末に保存され、再表示やオフライン時に使われます。']
          .filter(Boolean)
          .join(' / ');
      }
    } catch {
      if (status) status.textContent = 'キャッシュ状態を取得できませんでした';
    }
  }

  private async onSearchInput(query: string, suggestions: HTMLElement): Promise<void> {
    const q = query.trim();
    const seq = ++this.searchSeq;
    if (q.length < 1) {
      this.searchAbort?.abort();
      suggestions.hidden = true;
      suggestions.innerHTML = '';
      return;
    }
    const places = await this.searchPlaces(q);
    if (this.destroyed || seq !== this.searchSeq) return;
    suggestions.innerHTML = '';
    if (places.length === 0) {
      suggestions.hidden = true;
      return;
    }
    suggestions.hidden = false;
    for (const place of places) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'maps-suggestion';
      btn.textContent = place.name;
      btn.addEventListener('click', () => {
        suggestions.hidden = true;
        this.setPlace(place);
      });
      suggestions.appendChild(btn);
    }
  }

  private async searchPlaces(query: string): Promise<Place[]> {
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    try {
      const res = await fetch(`/api/maps/geocode?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { places: Place[] };
      return data.places ?? [];
    } catch {
      return [];
    }
  }

  private setPlace(place: Place): void {
    const slug = normalizeSlug(place.cityId || '');
    const existing = this.cities.find((c) => c.id === slug);
    this.activeCity = existing ?? {
      id: slug,
      name: place.name,
      nameEn: place.name,
      centerLat: place.lat,
      centerLon: place.lon,
      bbox: [place.lon - 0.4, place.lat - 0.4, place.lon + 0.4, place.lat + 0.4],
      zoom: 13,
      pmtilesPublished: false,
      valhallaPublished: false,
    };
    this.centerOnMap(place.lat, place.lon, 13);
    this.placeMarker(place.lat, place.lon);
    this.element.querySelectorAll('.maps-city-btn').forEach((el) => {
      el.classList.toggle('maps-city-btn--active', el.getAttribute('data-city') === slug);
    });
    const status = this.element.querySelector('[data-testid="maps-pack-status"]');
    if (status) {
      status.textContent = `${this.activeCity.name}: ${this.activeCity.pmtilesPublished || this.activeCity.valhallaPublished ? '配信済み' : 'ライブ表示中'}`;
    }
    this.loadWeather();
  }

  private async loadCities(): Promise<void> {
    try {
      const res = await fetch('/api/maps/cities', { credentials: 'include' });
      if (!res.ok || this.destroyed) return;
      const data = (await res.json()) as { cities: City[]; style?: string };
      if (this.destroyed) return;
      if (data.style) {
        this.styleUrl = data.style;
        if (this.map) {
          this.map.setStyle(this.styleUrl);
        }
      }
      if (Array.isArray(data.cities) && data.cities.length > 0) {
        this.cities = data.cities;
        const existing = this.cities.find((c) => c.id === this.activeCity.id);
        if (existing) {
          this.activeCity = existing;
          this.centerOnMap(existing.centerLat, existing.centerLon, existing.zoom);
          const status = this.element.querySelector('[data-testid="maps-pack-status"]');
          if (status) {
            status.textContent = `${existing.name}: ${existing.pmtilesPublished || existing.valhallaPublished ? '配信済み' : 'ライブ表示中'}`;
          }
        }
      }
    } catch {
      // Fallback to static cities
    }
    this.loadWeather();
  }

  private async loadWeather(): Promise<void> {
    this.weatherAbort?.abort();
    const controller = new AbortController();
    this.weatherAbort = controller;
    try {
      const res = await fetch(`/api/maps/weather?lat=${this.lat}&lon=${this.lon}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('weather unavailable');
      const data = (await res.json()) as WeatherPayload;
      if (this.destroyed) return;
      // Weather is rendered in the Right Panel; broadcast the payload.
      window.dispatchEvent(new CustomEvent('flaxia:mapweather', { detail: { lat: this.lat, lon: this.lon, data } }));
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      window.dispatchEvent(
        new CustomEvent('flaxia:mapweather', { detail: { lat: this.lat, lon: this.lon, error: true } }),
      );
    }
  }
}

export function createMapsPage(props: MapsPageProps = {}): MapsPage {
  return new MapsPage(props);
}
