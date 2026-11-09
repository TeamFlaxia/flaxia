import { Hono } from 'hono';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { kvCacheGet, kvCacheSet, parseRange } from '../helpers';
import type { Bindings, Variables } from '../types';

export interface MapsCity {
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

export interface MapsPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: string;
  cityId: string;
}

type MetSeries = {
  time: string;
  data: {
    instant: { details: Record<string, number> };
    nextOneHours?: { summary: { symbolCode: string }; details?: Record<string, number> };
    nextSixHours?: { summary: { symbolCode: string }; details?: Record<string, number> };
  };
};

type MetResponse = {
  properties: { meta: { units: Record<string, string> }; timeseries: MetSeries[] };
};

type WeatherPoint = {
  time: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  precipitation: number | null;
  symbol: string | null;
};

type WeatherCache = {
  lat: number;
  lon: number;
  updatedAt: string;
  points: WeatherPoint[];
};

const CITIES: Array<Omit<MapsCity, 'pmtilesPublished' | 'valhallaPublished'>> = [
  {
    id: 'tokyo',
    name: '東京',
    nameEn: 'Tokyo',
    centerLat: 35.6762,
    centerLon: 139.6503,
    bbox: [139.25, 35.45, 140.05, 35.85],
    zoom: 13,
  },
  {
    id: 'osaka',
    name: '大阪',
    nameEn: 'Osaka',
    centerLat: 34.6937,
    centerLon: 135.5023,
    bbox: [135.15, 34.45, 135.85, 34.85],
    zoom: 13,
  },
  {
    id: 'nagoya',
    name: '名古屋',
    nameEn: 'Nagoya',
    centerLat: 35.1812,
    centerLon: 136.9064,
    bbox: [136.55, 35.0, 137.25, 35.35],
    zoom: 13,
  },
];

const CITY_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

function isValidCitySlug(value: string): boolean {
  return CITY_SLUG.test(value);
}

function toWeatherPoints(data: MetResponse): WeatherPoint[] {
  const units = data.properties?.meta?.units ?? {};
  return (data.properties?.timeseries ?? []).slice(0, 48).map((row) => {
    const details = row.data?.instant?.details ?? {};
    const nextOne = row.data?.nextOneHours;
    const nextSix = row.data?.nextSixHours;
    const tempKey = Object.keys(details).find((k) => k.includes('temperature'));
    const humKey = Object.keys(details).find((k) => k.includes('humidity'));
    const windKey = Object.keys(details).find((k) => k.includes('wind_speed'));
    const windDirKey = Object.keys(details).find((k) => k.includes('wind_from_direction'));
    const precip = nextOne?.details?.precipitation_amount ?? nextSix?.details?.precipitation_amount ?? null;
    void units;
    return {
      time: row.time,
      temperature: tempKey ? details[tempKey] : null,
      humidity: humKey ? details[humKey] : null,
      windSpeed: windKey ? details[windKey] : null,
      windDirection: windDirKey ? details[windDirKey] : null,
      precipitation: precip,
      symbol: nextOne?.summary?.symbolCode ?? nextSix?.summary?.symbolCode ?? null,
    };
  });
}

async function packPublished(c: { env: Bindings }, cityId: string, file: string): Promise<boolean> {
  try {
    const obj = await c.env.BUCKET.head(`maps/${cityId}/${file}`);
    return obj != null;
  } catch {
    return false;
  }
}

const maps = new Hono<{ Bindings: Bindings; Variables: Variables }>();

maps.get('/maps/cities', async (c) => {
  const limited = await checkRateLimit(c.env.CACHE, `maps-cities:${getClientIp(c.req.raw)}`, {
    maxRequests: 120,
    windowSeconds: 60,
  });
  if (!limited) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  const cities: MapsCity[] = await Promise.all(
    CITIES.map(async (city) => ({
      ...city,
      pmtilesPublished: await packPublished(c, city.id, 'map.pmtiles'),
      valhallaPublished: await packPublished(c, city.id, 'valhalla.tar'),
    })),
  );
  const worldPublished = await packPublished(c, 'world', 'map.pmtiles');
  const styleUrl = c.env.MAPS_STYLE_URL?.trim() || 'https://tiles.openfreemap.org/styles/liberty';
  return c.json({ cities, world: { id: 'world', pmtilesPublished: worldPublished }, style: styleUrl });
});

maps.get('/maps/geocode', async (c) => {
  const limited = await checkRateLimit(c.env.CACHE, `maps-geocode:${getClientIp(c.req.raw)}`, {
    maxRequests: 120,
    windowSeconds: 60,
  });
  if (!limited) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  if (!q) {
    return c.json({ places: [] });
  }
  const limit = 10;
  let places: MapsPlace[] = [];
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, name, lat, lon, kind, city_id FROM maps_places
       WHERE name LIKE ? OR name_norm LIKE ? COLLATE NOCASE
       ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, LENGTH(name)
       LIMIT ?`,
    )
      .bind(`%${q}%`, `%${q}%`, q, limit)
      .all<{ id: string; name: string; lat: number; lon: number; kind: string; city_id: string }>();
    places = (rows.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
      kind: r.kind,
      cityId: r.city_id,
    }));
  } catch {
    return c.json({ places: [], error: 'geocode unavailable' }, 500);
  }
  return c.json({ places });
});

maps.get('/maps/weather', async (c) => {
  const limited = await checkRateLimit(c.env.CACHE, `maps-weather:${getClientIp(c.req.raw)}`, {
    maxRequests: 60,
    windowSeconds: 60,
  });
  if (!limited) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  const latRaw = Number(c.req.query('lat'));
  const lonRaw = Number(c.req.query('lon'));
  if (
    !Number.isFinite(latRaw) ||
    !Number.isFinite(lonRaw) ||
    latRaw < -90 ||
    latRaw > 90 ||
    lonRaw < -180 ||
    lonRaw > 180
  ) {
    return c.json({ error: 'Invalid coordinates' }, 400);
  }
  const lat = Math.round(latRaw * 100) / 100;
  const lon = Math.round(lonRaw * 100) / 100;
  const cacheKey = `maps-weather:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = await kvCacheGet<WeatherCache>(c, cacheKey);
  if (cached) {
    return c.json(cached);
  }
  const upstreamUrl = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'FlaxiaMaps/1.0 (+https://flaxia.app)',
        Accept: 'application/json',
      },
    });
  } catch {
    return c.json({ error: 'Weather upstream unavailable' }, 502);
  }
  if (!upstream.ok) {
    return c.json({ error: 'Weather upstream unavailable' }, 502);
  }
  let data: MetResponse;
  try {
    data = (await upstream.json()) as MetResponse;
  } catch {
    return c.json({ error: 'Weather upstream invalid' }, 502);
  }
  const payload: WeatherCache = {
    lat,
    lon,
    updatedAt: new Date().toISOString(),
    points: toWeatherPoints(data),
  };
  await kvCacheSet(c, cacheKey, payload, 600);
  return c.json(payload);
});

maps.get('/maps/packs/:city/:kind', async (c) => {
  const city = c.req.param('city');
  const kind = c.req.param('kind');
  if (!isValidCitySlug(city) || (kind !== 'pmtiles' && kind !== 'valhalla')) {
    return c.json({ error: 'Pack not found' }, 404);
  }
  const limited = await checkRateLimit(c.env.CACHE, `maps-pack:${city}:${getClientIp(c.req.raw)}`, {
    maxRequests: 60,
    windowSeconds: 60,
  });
  if (!limited) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  const file = kind === 'pmtiles' ? 'map.pmtiles' : 'valhalla.tar';
  const key = `maps/${city}/${file}`;
  const meta = await c.env.BUCKET.head(key).catch(() => null);
  if (!meta) {
    return c.json({ error: 'Pack not published' }, 404);
  }
  const fileSize = meta.size ?? 0;
  const rangeHeader = c.req.header('Range') ?? null;
  const baseHeaders = {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/octet-stream',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if (!rangeHeader) {
    const object = await c.env.BUCKET.get(key);
    if (!object) {
      return c.json({ error: 'Pack not published' }, 404);
    }
    return new Response(object.body, {
      headers: { ...baseHeaders, 'Content-Length': fileSize.toString() },
    });
  }
  if (fileSize <= 0) {
    return c.json({ error: 'Pack not published' }, 404);
  }
  const range = parseRange(rangeHeader, fileSize);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }
  const chunkSize = range.end - range.start + 1;
  const ranged = await c.env.BUCKET.get(key, {
    range: { offset: range.start, length: chunkSize },
  });
  if (!ranged) {
    return c.json({ error: 'Pack not published' }, 404);
  }
  return new Response(ranged.body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
      'Content-Length': chunkSize.toString(),
    },
  });
});

export default maps;
