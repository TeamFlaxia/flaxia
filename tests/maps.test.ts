import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { rewriteTileUrl, TILE_CACHE_NAME, TILE_ORIGINS, unwrapTileUrl } from '../src/lib/maps/cache.ts';
import { BASE_URL, resetDb } from './helpers/setup.ts';

describe('tile cache URL routing', () => {
  it('rewrites the vector tile paths used by the Liberty style', () => {
    const planet = 'https://tiles.openfreemap.org/planet/14/14550/6450.pbf';
    assert.equal(rewriteTileUrl(planet), `flaxia-tiles://${planet}`);
    assert.equal(unwrapTileUrl(`flaxia-tiles://${planet}`), planet);

    const legacy = 'https://tiles.openfreemap.org/tiles/14/14550/6450.pbf';
    assert.equal(rewriteTileUrl(legacy), `flaxia-tiles://${legacy}`);
  });

  it('leaves raster and foreign URLs untouched', () => {
    assert.equal(rewriteTileUrl('https://tiles.openfreemap.org/natural_earth/1/0/0.png'), null);
    assert.equal(rewriteTileUrl('https://example.com/planet/1/0/0.pbf'), null);
    assert.equal(unwrapTileUrl('flaxia-tiles://https://example.com/planet/1/0/0.pbf'), null);
    assert.equal(unwrapTileUrl('https://tiles.openfreemap.org/planet/1/0/0.pbf'), null);
    // The native auth deep link shares neither scheme nor origin with tiles.
    assert.equal(unwrapTileUrl('flaxia://auth/callback'), null);
  });

  it('keeps the standalone worker cache policy in sync with cache.ts', () => {
    const worker = readFileSync(new URL('../src/lib/maps/protocol-worker.js', import.meta.url), 'utf8');
    assert.ok(worker.includes(`'${TILE_CACHE_NAME}'`), 'worker cache name must match TILE_CACHE_NAME');
    for (const origin of TILE_ORIGINS) {
      assert.ok(worker.includes(`'${origin}'`), `worker must allow ${origin}`);
    }
    assert.ok(worker.includes('const MAX_BYTES = 200 * 1024 * 1024;'), 'worker byte cap must match cache.ts');
    assert.ok(worker.includes('const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;'), 'worker TTL must match cache.ts');
  });
});

describe('GET /api/maps/cities', () => {
  beforeEach(resetDb);

  it('returns curated cities and a style url', async () => {
    const res = await fetch(`${BASE_URL}/api/maps/cities`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      cities: Array<{ id: string }>;
      style: string;
      world: { id: string };
    };
    assert.ok(Array.isArray(data.cities));
    assert.ok(data.cities.some((c) => c.id === 'tokyo'));
    assert.ok(data.cities.some((c) => c.id === 'osaka'));
    assert.ok(data.style.length > 0);
    assert.equal(data.world.id, 'world');
  });
});

describe('GET /api/maps/geocode', () => {
  beforeEach(resetDb);

  it('finds seeded places', async () => {
    const res = await fetch(`${BASE_URL}/api/maps/geocode?q=${encodeURIComponent('東京')}`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { places: Array<{ id: string }> };
    assert.ok(data.places.some((p) => p.id === 'tokyo'));
  });

  it('escapes LIKE wildcards so % and _ match literally', async () => {
    const percent = await fetch(`${BASE_URL}/api/maps/geocode?q=%25`);
    assert.equal(percent.status, 200);
    const percentData = (await percent.json()) as { places: unknown[] };
    assert.equal(percentData.places.length, 0);

    const underscore = await fetch(`${BASE_URL}/api/maps/geocode?q=_`);
    assert.equal(underscore.status, 200);
    const underscoreData = (await underscore.json()) as { places: unknown[] };
    assert.equal(underscoreData.places.length, 0);
  });

  it('returns an empty list for an empty query', async () => {
    const res = await fetch(`${BASE_URL}/api/maps/geocode?q=`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { places: unknown[] };
    assert.deepEqual(data.places, []);
  });
});

describe('GET /api/maps/weather', () => {
  beforeEach(resetDb);

  it('rejects invalid coordinates with 400', async () => {
    for (const path of [
      'lat=abc&lon=139',
      'lat=100&lon=139',
      'lat=35&lon=181',
      'lat=&lon=139',
      'lat=35&lon=',
      'lat=35',
    ]) {
      const res = await fetch(`${BASE_URL}/api/maps/weather?${path}`);
      assert.equal(res.status, 400, path);
    }
  });
});

describe('GET /api/maps/packs/:city/:kind', () => {
  beforeEach(resetDb);

  it('returns 404 for a bad slug or unknown kind', async () => {
    const bad = await fetch(`${BASE_URL}/api/maps/packs/INVALID!/pmtiles`);
    assert.equal(bad.status, 404);
    const unknown = await fetch(`${BASE_URL}/api/maps/packs/tokyo/raster`);
    assert.equal(unknown.status, 404);
  });

  it('returns 404 when the pack is not published', async () => {
    const res = await fetch(`${BASE_URL}/api/maps/packs/tokyo/pmtiles`);
    assert.equal(res.status, 404);
  });
});
