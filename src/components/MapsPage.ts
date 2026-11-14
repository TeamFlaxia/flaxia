import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { getTileCacheStats, handleTileFetch, rewriteTileUrl, unwrapTileUrl } from '../lib/maps/cache.js';
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

export class MapsPage {
  private element: HTMLElement;
  private cities: City[] = FALLBACK_CITIES;
  private activeCity: City = FALLBACK_CITIES[0];
  private lat: number = FALLBACK_CITIES[0].centerLat;
  private lon: number = FALLBACK_CITIES[0].centerLon;
  private zoom: number = FALLBACK_CITIES[0].zoom;
  private located = false;
  private currentLocation: { lat: number; lon: number } | null = null;
  private currentHeading: number | null = null;
  private destroyed = false;
  private weatherAbort: AbortController | null = null;
  private searchAbort: AbortController | null = null;
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
  private overlayMode = 0; // 0=off, 1=気温, 2=温度, 3=雲, 4=雨

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
    void this.locateMe();
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

    const weatherOverlay = document.createElement('div');
    weatherOverlay.className = 'maps-weather-overlay';
    weatherOverlay.dataset.testid = 'maps-weather-overlay';
    weatherOverlay.textContent = '…';
    viewport.appendChild(weatherOverlay);

    const cloudOverlay = document.createElement('canvas');
    cloudOverlay.className = 'maps-cloud-overlay';
    cloudOverlay.dataset.testid = 'maps-cloud-overlay';
    cloudOverlay.hidden = true;
    viewport.appendChild(cloudOverlay);

    const overlaySwitch = document.createElement('div');
    overlaySwitch.className = 'maps-overlay-switch';
    overlaySwitch.dataset.testid = 'maps-overlay-switch';
    const modeIcons = [
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M8 6h8M8 18h8"/><circle cx="12" cy="12" r="3"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18c-2 0-4-2-4-4s2-4 4-4c0-3 2-6 6-6s6 3 6 6c2 0 4 2 4 4s-2 4-4 4H6z"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 12a6 6 0 0 1 12 0c0 4-6 10-6 10s-6-6-6-10z"/></svg>',
    ];
    const modeLabels = ['オフ', '気温マップ', '温度マップ', '雲マップ', '雨マップ'];
    for (let i = 0; i < modeIcons.length; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `maps-overlay-btn${i === this.overlayMode ? ' maps-overlay-btn--active' : ''}`;
      btn.dataset.mode = String(i);
      btn.title = modeLabels[i];
      btn.innerHTML = modeIcons[i];
      overlaySwitch.appendChild(btn);
    }
    viewport.appendChild(overlaySwitch);
    const attribution = document.createElement('div');
    attribution.className = 'maps-attribution';
    attribution.textContent = '© OpenFreeMap © OpenMapTiles Data from OpenStreetMap / © MET Norway / © GeoNames';
    viewport.appendChild(attribution);
    root.appendChild(viewport);
    return root;
  }

  private attachEvents(): void {
    const switchEl = this.element.querySelector('[data-testid="maps-overlay-switch"]') as HTMLElement | null;
    if (switchEl) {
      switchEl.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest('button');
        if (!target) return;
        const mode = Number(target.dataset.mode);
        if (Number.isNaN(mode)) return;
        this.overlayMode = mode;
        switchEl.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('maps-overlay-btn--active', Number(b.dataset.mode) === mode);
        });
        this.updateOverlay();
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
      if (this.located && this.currentLocation) {
        this.placeMarker(this.currentLocation.lat, this.currentLocation.lon);
      }
      map.addControl(new maplibre.NavigationControl({}), 'bottom-right');
      map.addControl(new maplibre.ScaleControl(), 'bottom-left');
      map.on('move', () => {
        if (!this.map || this.destroyed) return;
        this.renderOverlayCanvas();
      });
      map.on('moveend', () => {
        if (!this.map || this.destroyed) return;
        const center = this.map.getCenter();
        this.lat = center.lat;
        this.lon = center.lng;
        this.zoom = Math.round(this.map.getZoom());
        void this.updateOverlay();
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

  private createLocationMarkerElement(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'maps-location-marker';
    el.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M12 2 L20 20 L12 15 L4 20 Z" fill="#2563eb" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
    const heading = this.currentHeading ?? 0;
    el.style.transform = `rotate(${heading}deg)`;
    return el;
  }

  private placeMarker(lat: number, lon: number): void {
    if (!this.map || !this.maplibre) return;
    this.marker?.remove();
    this.marker = new this.maplibre.Marker({ element: this.createLocationMarkerElement(), anchor: 'center' })
      .setLngLat([lon, lat])
      .addTo(this.map);
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
        if (!this.located) {
          const existing = this.cities.find((c) => c.id === this.activeCity.id);
          if (existing) {
            this.activeCity = existing;
            this.centerOnMap(existing.centerLat, existing.centerLon, existing.zoom);
          }
        }
      }
    } catch {
      // Fallback to static cities
    }
    this.loadWeather();
  }

  private symbolLabel(symbol: string | null): string {
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

  private async locateMe(): Promise<void> {
    let pos: { lat: number; lon: number } | null = null;
    if (navigator.geolocation) {
      pos = await new Promise<{ lat: number; lon: number } | null>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => {
            this.currentHeading =
              typeof p.coords.heading === 'number' && Number.isFinite(p.coords.heading) ? p.coords.heading : null;
            resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
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
    if (!pos || this.destroyed) return;
    this.lat = pos.lat;
    this.lon = pos.lon;
    this.zoom = 13;
    this.located = true;
    this.currentLocation = pos;
    this.centerOnMap(pos.lat, pos.lon, 13);
    this.placeMarker(pos.lat, pos.lon);
    this.loadWeather();
  }

  private async loadWeather(): Promise<void> {
    this.weatherAbort?.abort();
    const controller = new AbortController();
    this.weatherAbort = controller;
    const overlay = this.element.querySelector('[data-testid="maps-weather-overlay"]') as HTMLElement | null;
    if (overlay) overlay.textContent = '…';
    try {
      const res = await fetch(`/api/maps/weather?lat=${this.lat}&lon=${this.lon}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('weather unavailable');
      const data = (await res.json()) as WeatherPayload;
      if (this.destroyed) return;
      if (!overlay) return;
      const current = data.points[0];
      this.updateOverlay();
      overlay.innerHTML = '';
      const temp = document.createElement('span');
      temp.className = 'maps-weather-temp';
      temp.textContent = current?.temperature != null ? `${Math.round(current.temperature)}°` : '--';
      const symbol = document.createElement('span');
      symbol.className = 'maps-weather-symbol';
      symbol.textContent = this.symbolLabel(current?.symbol ?? null);
      overlay.appendChild(temp);
      overlay.appendChild(symbol);
      const meta = document.createElement('div');
      meta.className = 'maps-note';
      const hum = current?.humidity != null ? `湿度 ${Math.round(current.humidity)}%` : '';
      const wind = current?.windSpeed != null ? `風速 ${current.windSpeed.toFixed(0)}m/s` : '';
      const cloud = current?.cloudCover != null ? `雲量 ${Math.round(current.cloudCover)}%` : '';
      meta.textContent = [hum, wind, cloud].filter(Boolean).join(' / ');
      overlay.appendChild(meta);

      // Next clear/sunny forecast
      const nextClear = data.points.slice(1).find((p) => {
        const s = (p.symbol ?? '').toLowerCase();
        return s.startsWith('clearsky') || s.startsWith('fair');
      });
      if (nextClear) {
        const fc = document.createElement('div');
        fc.className = 'maps-note';
        const t = new Date(nextClear.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        fc.textContent = `次に晴れるのは ${t}（${this.symbolLabel(nextClear.symbol)}）`;
        overlay.appendChild(fc);
      }
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      if (overlay) overlay.textContent = '天気を取得できませんでした';
    }
  }

  private gridWeatherCache: Map<
    string,
    { temp: number | null; cloud: number | null; precip: number | null; symbol: string | null }
  > = new Map();

  private lastOverlayGrid: {
    cells: { i: number; j: number; lat: number; lon: number; key: string }[];
    west: number;
    east: number;
    north: number;
    south: number;
    lonStep: number;
    latStep: number;
    cols: number;
    rows: number;
  } | null = null;

  private async updateOverlay(): Promise<void> {
    const canvas = this.element.querySelector('[data-testid="maps-cloud-overlay"]') as HTMLCanvasElement | null;
    if (!canvas) return;
    if (this.overlayMode === 0) {
      canvas.hidden = true;
      return;
    }
    if (!this.map || this.zoom > 10) {
      canvas.hidden = true;
      return;
    }
    canvas.hidden = false;
    const bounds = this.map.getBounds();
    const cols = 5;
    const rows = 5;
    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();
    const lonStep = (east - west) / cols;
    const latStep = (north - south) / rows;

    // Collect cell centers
    const cells: { i: number; j: number; lat: number; lon: number; key: string }[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const lon = west + lonStep * (i + 0.5);
        const lat = north - latStep * (j + 0.5);
        cells.push({ i, j, lat, lon, key: `${lat.toFixed(2)},${lon.toFixed(2)}` });
      }
    }
    this.lastOverlayGrid = { cells, west, east, north, south, lonStep, latStep, cols, rows };

    // Fetch weather for cells not cached
    await Promise.all(
      cells.map(async (cell) => {
        if (this.gridWeatherCache.has(cell.key)) return;
        try {
          const res = await fetch(`/api/maps/weather?lat=${cell.lat}&lon=${cell.lon}`, { credentials: 'include' });
          if (res.ok) {
            const data = (await res.json()) as { points?: any[] };
            const p = data.points?.[0];
            if (p) {
              this.gridWeatherCache.set(cell.key, {
                temp: p.temperature ?? null,
                cloud: p.cloudCover ?? null,
                precip: p.precipitation ?? null,
                symbol: p.symbol ?? null,
              });
            }
          }
        } catch {
          // ignore
        }
      }),
    );

    if (this.destroyed) return;

    const rect = (canvas.parentElement ?? canvas).getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Drawing is handled by renderOverlayCanvas (also called on 'move' for smooth panning).
    this.renderOverlayCanvas();
    return;
  }

  private renderOverlayCanvas(): void {
    const canvas = this.element.querySelector('[data-testid="maps-cloud-overlay"]') as HTMLCanvasElement | null;
    if (!canvas || !this.map || this.overlayMode === 0 || this.zoom > 10) {
      if (canvas) canvas.hidden = true;
      return;
    }
    const grid = this.lastOverlayGrid;
    if (!grid) return;
    canvas.hidden = false;
    const rect = (canvas.parentElement ?? canvas).getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const { cells, west, north, lonStep, latStep } = grid;
    for (const cell of cells) {
      const wdata = this.gridWeatherCache.get(cell.key);
      const nw = this.map.project([west + lonStep * cell.i, north - latStep * cell.j]);
      const se = this.map.project([west + lonStep * (cell.i + 1), north - latStep * (cell.j + 1)]);
      const x = Math.min(nw.x, se.x);
      const y = Math.min(nw.y, se.y);
      const cw = Math.abs(se.x - nw.x);
      const ch = Math.abs(se.y - nw.y);
      let color = 'rgba(0,0,0,0)';
      let opacity = 0.35;
      if (this.overlayMode === 1 || this.overlayMode === 2) {
        const t = wdata?.temp ?? 15;
        const hue = Math.max(0, Math.min(240, 240 - (t + 10) * 6));
        color = `hsl(${hue}, 75%, 50%)`;
        opacity = 0.35;
      } else if (this.overlayMode === 3) {
        const c = wdata?.cloud ?? 0;
        opacity = Math.min(0.6, (c / 100) * 0.6);
        color = 'rgba(255, 255, 255, 1)';
      } else if (this.overlayMode === 4) {
        const p = wdata?.precip ?? 0;
        if (p <= 0) {
          color = 'rgba(0,0,0,0)';
          opacity = 0;
        } else {
          const hue = 240 - Math.min(40, p * 4);
          color = `hsl(${hue}, 70%, 50%)`;
          opacity = Math.min(0.6, 0.2 + (p / 10) * 0.4);
        }
      }
      ctx.globalAlpha = opacity;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, cw, ch);
    }
    ctx.globalAlpha = 1;
  }
}

export function createMapsPage(props: MapsPageProps = {}): MapsPage {
  return new MapsPage(props);
}
