import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { t } from '../lib/i18n.js';
import {
  clearTileCache,
  getTileCacheStats,
  handleTileFetch,
  requestStoragePersistence,
  rewriteTileUrl,
  unwrapTileUrl,
} from '../lib/maps/cache.js';
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

const MAX_PACK_BYTES = 100 * 1024 * 1024;

function symbolLabel(symbol: string | null): string {
  if (!symbol) return '';
  const s = symbol.toLowerCase();
  if (s.startsWith('clearsky')) return '晴れ';
  if (s.startsWith('fair')) return '晴れ時々曇り';
  if (s.startsWith('cloudy')) return '曇り';
  if (s.startsWith('fog')) return '霧';
  if (s.includes('thunder')) return '雷雨';
  if (s.startsWith('rain')) return '雨';
  if (s.startsWith('snow')) return '雪';
  if (s.startsWith('sleet')) return 'みぞれ';
  return symbol;
}

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
        this.maplibre.removeProtocol('flaxia');
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

    const cityBar = document.createElement('div');
    cityBar.className = 'maps-city-bar';
    cityBar.dataset.testid = 'maps-city-bar';
    for (const city of FALLBACK_CITIES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `maps-city-btn${city.id === this.activeCity.id ? ' maps-city-btn--active' : ''}`;
      btn.textContent = city.name;
      btn.dataset.city = city.id;
      btn.addEventListener('click', () => {
        this.setCity(city.id);
      });
      cityBar.appendChild(btn);
    }
    const worldBtn = document.createElement('button');
    worldBtn.type = 'button';
    worldBtn.className = 'maps-city-btn';
    worldBtn.textContent = '世界';
    worldBtn.addEventListener('click', () => {
      this.activeCity = {
        id: 'world',
        name: '世界',
        nameEn: 'World',
        centerLat: 35,
        centerLon: 139,
        bbox: [-180, -90, 180, 90],
        zoom: 3,
        pmtilesPublished: false,
        valhallaPublished: false,
      };
      this.lat = 35;
      this.lon = 139;
      this.zoom = 3;
      this.removeMarker();
      this.centerOnMap(35, 139, 3);
      this.element.querySelectorAll('.maps-city-btn').forEach((el) => {
        el.classList.remove('maps-city-btn--active');
      });
      const status = this.element.querySelector('[data-testid="maps-pack-status"]');
      if (status) status.textContent = '世界: ライブ表示';
      this.loadWeather();
    });
    cityBar.appendChild(worldBtn);
    controls.appendChild(cityBar);
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
    mapError.textContent = '地図を表示できませんでした。ブラウザのWebGLを有効にしてください。';
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

    const cachePanel = document.createElement('section');
    cachePanel.className = 'maps-panel maps-panel--cache';
    cachePanel.dataset.testid = 'maps-cache';
    cachePanel.appendChild(this.panelTitle('端末キャッシュ / On-device cache'));
    const cacheBody = document.createElement('div');
    const cacheStatus = document.createElement('p');
    cacheStatus.className = 'maps-pack-status';
    cacheStatus.dataset.testid = 'maps-cache-status';
    cacheStatus.textContent = '確認中…';
    cacheBody.appendChild(cacheStatus);
    const cacheDetail = document.createElement('p');
    cacheDetail.className = 'maps-note';
    cacheDetail.dataset.testid = 'maps-cache-detail';
    cacheDetail.textContent = '表示したタイルは端末に保存され、再表示やオフライン時に使われます。';
    cacheBody.appendChild(cacheDetail);
    const cacheActions = document.createElement('div');
    cacheActions.className = 'maps-cache-actions';
    const persistBtn = document.createElement('button');
    persistBtn.type = 'button';
    persistBtn.className = 'maps-btn maps-btn--ghost';
    persistBtn.textContent = 'オフライン保存を許可';
    persistBtn.addEventListener('click', () => {
      void (async () => {
        const ok = await requestStoragePersistence();
        cacheStatus.textContent = ok ? '保存が許可されました' : 'このブラウザでは許可できませんでした';
      })();
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'maps-btn maps-btn--ghost';
    clearBtn.textContent = 'キャッシュ削除';
    clearBtn.addEventListener('click', () => {
      void (async () => {
        await clearTileCache();
        this.tileHits = 0;
        this.tileMisses = 0;
        await this.refreshCacheStatus();
      })();
    });
    cacheActions.appendChild(persistBtn);
    cacheActions.appendChild(clearBtn);
    cacheBody.appendChild(cacheActions);
    cachePanel.appendChild(cacheBody);
    root.appendChild(cachePanel);

    const panels = document.createElement('div');
    panels.className = 'maps-panels';

    const weatherPanel = document.createElement('section');
    weatherPanel.className = 'maps-panel';
    weatherPanel.dataset.testid = 'maps-weather';
    weatherPanel.appendChild(this.panelTitle('天気 / Weather'));
    const weatherBody = document.createElement('div');
    weatherBody.dataset.testid = 'maps-weather-body';
    weatherBody.textContent = '…';
    weatherPanel.appendChild(weatherBody);
    panels.appendChild(weatherPanel);

    const packPanel = document.createElement('section');
    packPanel.className = 'maps-panel';
    packPanel.dataset.testid = 'maps-pack';
    packPanel.appendChild(this.panelTitle('都市タイル / City pack'));
    const packBody = document.createElement('div');
    packBody.dataset.testid = 'maps-pack-body';
    const packStatus = document.createElement('p');
    packStatus.className = 'maps-pack-status';
    packStatus.dataset.testid = 'maps-pack-status';
    packStatus.textContent = '東京: ライブ表示中';
    packBody.appendChild(packStatus);
    const packBtn = document.createElement('button');
    packBtn.type = 'button';
    packBtn.className = 'maps-btn maps-btn--ghost';
    packBtn.textContent = '地図タイル取得 / Fetch';
    packBtn.addEventListener('click', () => {
      void this.downloadPack();
    });
    packBody.appendChild(packBtn);
    const progress = document.createElement('div');
    progress.className = 'maps-progress';
    progress.hidden = true;
    const progressBar = document.createElement('div');
    progressBar.className = 'maps-progress-bar';
    progress.appendChild(progressBar);
    packBody.appendChild(progress);
    packPanel.appendChild(packBody);
    panels.appendChild(packPanel);

    const routePanel = document.createElement('section');
    routePanel.className = 'maps-panel';
    routePanel.dataset.testid = 'maps-route';
    routePanel.appendChild(this.panelTitle('経路 / Route'));
    const routeForm = document.createElement('div');
    const fromRow = document.createElement('div');
    fromRow.className = 'maps-route-row';
    const fromLabel = document.createElement('label');
    fromLabel.textContent = '出発地';
    const fromInput = document.createElement('input');
    fromInput.className = 'maps-route-input';
    fromInput.dataset.testid = 'maps-route-from';
    fromInput.placeholder = '新宿';
    fromRow.appendChild(fromLabel);
    fromRow.appendChild(fromInput);
    const toRow = document.createElement('div');
    toRow.className = 'maps-route-row';
    const toLabel = document.createElement('label');
    toLabel.textContent = '目的地';
    const toInput = document.createElement('input');
    toInput.className = 'maps-route-input';
    toInput.dataset.testid = 'maps-route-to';
    toInput.placeholder = '渋谷';
    toRow.appendChild(toLabel);
    toRow.appendChild(toInput);
    const modeRow = document.createElement('div');
    modeRow.className = 'maps-route-row';
    const modeLabel = document.createElement('label');
    modeLabel.textContent = '移動手段';
    const modeSelect = document.createElement('select');
    modeSelect.className = 'maps-route-mode';
    modeSelect.dataset.testid = 'maps-route-mode';
    for (const [value, label] of [
      ['auto', '車'],
      ['pedestrian', '徒歩'],
      ['bicycle', '自転車'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    }
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    const routeBtn = document.createElement('button');
    routeBtn.type = 'button';
    routeBtn.className = 'maps-btn';
    routeBtn.dataset.testid = 'maps-route-btn';
    routeBtn.textContent = '経路案内';
    routeBtn.addEventListener('click', () => {
      void this.searchRoute(fromInput.value, toInput.value, modeSelect.value);
    });
    const routeNote = document.createElement('p');
    routeNote.className = 'maps-note';
    routeNote.dataset.testid = 'maps-route-note';
    routeNote.textContent = '都市タイルが配信後に経路計算します。';
    routeForm.appendChild(fromRow);
    routeForm.appendChild(toRow);
    routeForm.appendChild(modeRow);
    routeForm.appendChild(routeBtn);
    routeForm.appendChild(routeNote);
    routePanel.appendChild(routeForm);
    panels.appendChild(routePanel);

    root.appendChild(panels);
    return root;
  }

  private panelTitle(text: string): HTMLHeadingElement {
    const h = document.createElement('h2');
    h.className = 'maps-panel-title';
    h.textContent = text;
    return h;
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

  private async initMap(): Promise<void> {
    const container = this.element.querySelector('.maps-libre-container') as HTMLElement | null;
    const fallback = this.element.querySelector('.maps-libre-fallback') as HTMLElement | null;
    if (!container) return;
    try {
      const maplibre = await import('maplibre-gl');
      if (this.destroyed) return;
      this.maplibre = maplibre;
      const workerUrl = (await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')).default;
      maplibre.setWorkerUrl(workerUrl);
      const protocolUrl = (await import('../lib/maps/protocol-worker.js?url')).default;
      await maplibre.importScriptInWorkers(protocolUrl);
      if (this.destroyed) return;
      const styleUrl: string = this.styleUrl;
      maplibre.addProtocol('flaxia', async (params, abortController) => {
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
      map.on('error', (e: { error?: unknown }) => {
        const message = String((e.error as { message?: string })?.message ?? '');
        if (message.includes('WebGL') || message.includes('GPU')) {
          if (fallback) {
            fallback.hidden = false;
            fallback.textContent = '地図を表示できませんでした。ブラウザのWebGLを有効にしてください。';
          }
        }
      });
      await this.refreshCacheStatus();
    } catch {
      if (fallback && !this.destroyed) {
        fallback.hidden = false;
        fallback.textContent = '地図を表示できませんでした。ブラウザのWebGLを有効にしてください。';
      }
    }
  }

  private centerOnMap(lat: number, lon: number, zoom: number): void {
    this.lat = lat;
    this.lon = lon;
    this.zoom = zoom;
    if (this.map) {
      this.map.flyTo({ center: [lon, lat], zoom, essential: true });
    }
  }

  private removeMarker(): void {
    this.marker?.remove();
    this.marker = null;
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

  private setCity(cityId: string): void {
    const city = this.cities.find((c) => c.id === cityId) ?? FALLBACK_CITIES.find((c) => c.id === cityId);
    if (!city) return;
    this.activeCity = city;
    this.removeMarker();
    this.centerOnMap(city.centerLat, city.centerLon, city.zoom);
    this.element.querySelectorAll('.maps-city-btn').forEach((el) => {
      el.classList.toggle('maps-city-btn--active', el.getAttribute('data-city') === cityId);
    });
    const status = this.element.querySelector('[data-testid="maps-pack-status"]');
    if (status) {
      status.textContent = `${city.name}: ${city.pmtilesPublished || city.valhallaPublished ? '配信済み' : 'ライブ表示中'}`;
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
    const body = this.element.querySelector('[data-testid="maps-weather-body"]');
    if (!body) return;
    body.textContent = '…';
    try {
      const res = await fetch(`/api/maps/weather?lat=${this.lat}&lon=${this.lon}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('weather unavailable');
      const data = (await res.json()) as WeatherPayload;
      if (this.destroyed) return;
      const current = data.points[0];
      body.innerHTML = '';
      const cur = document.createElement('div');
      cur.className = 'maps-weather-current';
      const temp = document.createElement('span');
      temp.className = 'maps-weather-temp';
      temp.textContent = current?.temperature != null ? `${Math.round(current.temperature)}°` : '--';
      const symbol = document.createElement('span');
      symbol.className = 'maps-weather-symbol';
      symbol.textContent = symbolLabel(current?.symbol ?? null);
      cur.appendChild(temp);
      cur.appendChild(symbol);
      body.appendChild(cur);
      const meta = document.createElement('div');
      meta.className = 'maps-note';
      const hum = current?.humidity != null ? `湿度 ${Math.round(current.humidity)}%` : '';
      const wind = current?.windSpeed != null ? `風速 ${current.windSpeed.toFixed(0)}m/s` : '';
      meta.textContent = [hum, wind, new Date(data.updatedAt).toLocaleTimeString()].filter(Boolean).join(' / ');
      body.appendChild(meta);
      const hourly = document.createElement('div');
      hourly.className = 'maps-hourly';
      for (const point of data.points.filter((_, i) => i % 6 === 0).slice(0, 8)) {
        const h = document.createElement('div');
        h.className = 'maps-hour';
        const time = document.createElement('div');
        time.textContent = new Date(point.time).toLocaleTimeString([], { hour: '2-digit' });
        const tempEl = document.createElement('div');
        tempEl.textContent = point.temperature != null ? `${Math.round(point.temperature)}°` : '--';
        const s = document.createElement('div');
        s.textContent = symbolLabel(point.symbol);
        h.appendChild(time);
        h.appendChild(tempEl);
        h.appendChild(s);
        hourly.appendChild(h);
      }
      body.appendChild(hourly);
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      body.textContent = '天気を取得できませんでした';
    }
  }

  private async downloadPack(): Promise<void> {
    const status = this.element.querySelector('[data-testid="maps-pack-status"]');
    const progress = this.element.querySelector('.maps-progress') as HTMLElement | null;
    const bar = this.element.querySelector('.maps-progress-bar') as HTMLElement | null;
    if (progress) {
      progress.hidden = false;
    }
    const controller = new AbortController();
    this.packAbort?.abort();
    this.packAbort = controller;
    try {
      const packPath = `/api/maps/packs/${encodeURIComponent(this.activeCity.id)}/pmtiles`;
      const res = await fetch(packPath, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        if (status) status.textContent = `${this.activeCity.name}: 未配信（ライブ表示中）`;
        return;
      }
      const total = Number(res.headers.get('Content-Length') || 0);
      if (total > MAX_PACK_BYTES) {
        await res.body.cancel().catch(() => undefined);
        if (status) status.textContent = `${this.activeCity.name}: パックが上限（100MB）を超えています`;
        return;
      }
      let received = 0;
      const counting = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, encoder) {
          received += chunk.byteLength;
          if (received > MAX_PACK_BYTES) {
            encoder.error(new Error('pack too large'));
            return;
          }
          if (bar && total > 0) {
            bar.style.width = `${Math.round((received / total) * 100)}%`;
          }
          encoder.enqueue(chunk);
        },
      });
      const streamed = res.body.pipeThrough(counting);
      const cache = await caches.open('flaxia-maps-packs');
      // Stream into Cache Storage instead of buffering the whole pack in memory.
      await cache.put(packPath, new Response(streamed, { headers: { 'Content-Type': 'application/octet-stream' } }));
      if (status) status.textContent = `${this.activeCity.name}: 取得済み (${Math.round(received / 1024 / 1024)}MB)`;
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      if (status) {
        status.textContent =
          (error as { message?: string }).message === 'pack too large'
            ? `${this.activeCity.name}: パックが上限（100MB）を超えています`
            : `${this.activeCity.name}: 取得に失敗しました`;
      }
    } finally {
      if (this.packAbort === controller) this.packAbort = null;
      if (progress) progress.hidden = true;
    }
  }

  private async searchRoute(fromText: string, toText: string, mode: string): Promise<void> {
    const note = this.element.querySelector('[data-testid="maps-route-note"]');
    const modeLabel = mode === 'pedestrian' ? '徒歩' : mode === 'bicycle' ? '自転車' : '車';
    if (!fromText || !toText) {
      if (note) note.textContent = '出発地と目的地を入力してください';
      return;
    }
    this.routeAbort?.abort();
    const routeAbort = new AbortController();
    this.routeAbort = routeAbort;
    const [from, to] = await Promise.all([
      this.findPlace(fromText, routeAbort.signal),
      this.findPlace(toText, routeAbort.signal),
    ]);
    if (this.destroyed) return;
    if (from) {
      this.centerOnMap(from.lat, from.lon, 13);
      this.placeMarker(from.lat, from.lon);
    }
    if (!from && !to) {
      if (note) note.textContent = '場所が見つかりませんでした';
      return;
    }
    if (!this.activeCity.valhallaPublished) {
      if (note)
        note.textContent = `${this.activeCity.name}の経路タイルは未配信です。配信後に${modeLabel}の経路案内をします。`;
      return;
    }
    if (note) note.textContent = `経路計算（${modeLabel}）は都市タイル配布後に有効化されます`;
  }

  private async findPlace(query: string, signal?: AbortSignal): Promise<Place | null> {
    let controller: AbortController | null = null;
    if (!signal) {
      this.searchAbort?.abort();
      controller = new AbortController();
      this.searchAbort = controller;
    }
    try {
      const res = await fetch(`/api/maps/geocode?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
        signal: signal ?? controller?.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { places: Place[] };
      return data.places[0] ?? null;
    } catch {
      return null;
    }
  }
}

export function createMapsPage(props: MapsPageProps = {}): MapsPage {
  return new MapsPage(props);
}
