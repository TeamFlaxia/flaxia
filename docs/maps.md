# Flaxia Maps & Weathers

Flaxia Maps & Weathers is the `/maps` page for Flaxia: a live map with on-device tile caching and point weather. It is built to run at $0 — map data comes from OpenStreetMap via OpenFreeMap, weather from MET Norway, and the app's own endpoints run on Cloudflare free tiers and D1/KV. City PMTiles/Valhalla packs are a roadmap subproject (see [City packs (roadmap)](#city-packs-roadmap)).

## Architecture

- Client: MapLibre GL (`maplibre-gl`) in `src/components/MapsPage.ts`, lazily loaded as a separate chunk when the `/maps` route opens. Pan/zoom work anywhere on the planet; search and quick-jump buttons jump to a place.
- Style + tiles: The style URL comes from the server (`GET /api/maps/cities` → `MAPS_STYLE_URL`, default `https://tiles.openfreemap.org/styles/liberty`, freely usable for commercial projects per OpenFreeMap's licensing). The page rewrites tile requests to an on-device mode with `transformRequest` (`src/lib/maps/cache.ts` → `rewriteTileUrl`).
- Tile protocol (on-device cache): `transformRequest` rewrites `https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf` (and the legacy `/tiles/` path) to `flaxia://…`, and the `flaxia://` protocol (registered on the main thread **and** in the worker via `maplibre.importScriptInWorkers` → `src/lib/maps/protocol-worker.js`) intercepts it. Each tile fetch is a Cache Storage (name `flaxia-tiles-v1`) read, upgraded by an ETag/304 background revalidate (stale-while-revalidate), with LRU eviction by IndexedDB metadata (`flaxia-tiles-meta`): 200 MB cap, 7-day TTL policy. Background revalidation is bounded (at most 4 concurrent, 60s per-URL cooldown) so panning across cached tiles cannot saturate the radio/IDB. The worker file is standalone JavaScript (shipped as an asset, no imports) and duplicates the fetch/cache/eviction policy by hand; keep its cache name, origins, and limits in sync with `cache.ts`.
- History (gone): PMTiles/R2 self-hosting and the `downloadPack` PMTiles target are not active in the current build. PMTiles/Valhalla infra remains only as the endpoints listed below plus `scripts/build-maps-packs.mjs`.
- Geocoding: D1 table `maps_places`, seeded with Tokyo/Osaka/Nagoya and a set of stations/landmarks. Global import uses `scripts/import-global-gazetteer.mjs` (GeoNames `cities500`, CC-BY) — commands are spawn-arg (no shell), and invalid lat/lon rows are skipped. `GET /api/maps/geocode?q=` matches `%{q}%` over `name` and `name_norm` (case-insensitive); `%`, `_`, `\` in `q` are escaped so they are matched literally.
- Weather: `GET /api/maps/weather?lat=&lon=` proxies MET Norway Locationforecast 2.0 (`api.met.no`), free without a key. Coordinates are rounded to 0.01° and cached in KV (10 minutes). Response is the next 48 hourly points; the UI shows current temperature plus an hourly strip. `symbolCode` is translated to Japanese labels (`clear_day` → 「晴れ」 etc.) on the client.
- Routing: the route form is a placeholder. It resolves start/end via `GET /api/maps/geocode`, moves the map/marker, but does not compute a route line — per-mode routing (Valhalla WASM) is a roadmap item. The button currently reports the mode (auto/pedestrian/bicycle) in its status note so users are not misled into thinking a route was drawn.

## City packs (roadmap)

The R2/PMTiles/Valhalla pack endpoints and `scripts/build-maps-packs.mjs` exist but the live `/maps` experience is OpenFreeMap. Endpoints are kept for a future self-hosted cutover:

- `GET /api/maps/packs/:city/pmtiles` / `/valhalla` — signed? (no: read-only, no auth; `Access-Control-Allow-Origin: *`, immutable caching, HTTP Range via `parseRange`). Anything that looks like an unpublished city returns 404; city slugs must match `[a-z0-9][a-z0-9-]{1,63}`. The client downloads packs with a streaming `Cache.put` (no whole-file JS buffering) capped at 100 MB.

Build (run in CI, not on the edge):

    node scripts/build-maps-packs.mjs maps-packs
    node scripts/build-maps-packs.mjs --out maps-packs --city kyoto "135.5,34.8,135.95,35.2" 15

Publish:

    wrangler r2 object put flaxia-content/maps/<city>/map.pmtiles --file maps-packs/<city>/map.pmtiles
    wrangler r2 object put flaxia-content/maps/<city>/valhalla.tar --file maps-packs/<city>/valhalla.tar

`GET /api/maps/cities` reports the curated cities and world low-zoom status.

## Global gazetteer import

    node scripts/import-global-gazetteer.mjs
    D1_REMOTE=1 node scripts/import-global-gazetteer.mjs

This downloads GeoNames cities500 (about 185k cities worldwide) and loads them into `maps_places`. Run once, then refresh monthly.

## API

- `GET /api/maps/cities` — curated city manifest plus world low-zoom status and the style URL
- `GET /api/maps/geocode?q=` — city/station search, worldwide after gazetteer import
- `GET /api/maps/weather?lat=&lon=` — point weather from MET Norway, cached
- `GET /api/maps/packs/:city/pmtiles` — city map tiles (Range), any city slug
- `GET /api/maps/packs/:city/valhalla` — city routing tiles (Range), any city slug

All endpoints are rate-limited per IP and need no API key.

## Limits

- City-level geocoding only, no street addresses.
- No live traffic and no high-resolution weather raster.
- Routing is per-city only (planned); long-distance or rural routing is out of scope for the $0 build.
- The live vector tiles depend on OpenFreeMap availability; on-device cache limits tile staleness but does not replace a live source.
