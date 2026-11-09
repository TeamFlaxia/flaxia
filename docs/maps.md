# Flaxia Maps & Weathers

Flaxia Maps & Weathers is the /maps page for Flaxia. It is built to run at $0 with no quota-based free tier: data comes from OpenStreetMap and open weather data, compute runs in the browser or in Cloudflare free tiers, and city tile packs are distributed on demand worldwide.

## Architecture

- Client: vanilla slippy map in src/components/MapsPage.ts. No map SDK bundled: tiles are plain images, attribution is visible. Pan and zoom work anywhere on the planet; search jumps to any city.
- Tiles: world low-zoom PMTiles (z0-10) in Cloudflare R2 plus per-city PMTiles packs (z12-15) fetched on demand and cached in Cache Storage. During development the page falls back to OpenStreetMap raster tiles until packs are published to R2.
- Geocoding: D1 table maps_places. Seeded with Tokyo, Osaka, Nagoya at launch; import the global cities index with scripts/import-global-gazetteer.mjs (GeoNames cities500, CC-BY). Query is a contains search over name and name_norm. City-level only, worldwide after import.
- Weather: proxied through the Worker at GET /api/maps/weather. Upstream is MET Norway Locationforecast 2.0 (api.met.no), free even for commercial use, global, no key. Responses are rounded to 0.01 deg and cached in KV for 10 minutes. No raster weather overlay in the $0 build; point weather and hourly forecast are shown instead.
- Routing: browser-side Valhalla WASM engine (Routewasm) over per-city Valhalla tile packs. One city pack is 11-30 MB and is downloaded on first use, then cached in OPFS/Cache Storage. Prefecture- or country-scale routing is not attempted in the browser.

## City packs

Global on-demand: any city slug matching [a-z0-9-]{2,64} can be published. Curated quick jumps are Tokyo, Osaka, Nagoya; search covers the whole world. Packs are generated per bbox.

Build (run in CI, not on the edge):

    node scripts/build-maps-packs.mjs maps-packs
    node scripts/build-maps-packs.mjs --out maps-packs --city kyoto "135.5,34.8,135.95,35.2" 15

    # inside maps-packs/<city>/build.sh:
    # planetiler --bbox=<bbox> --maxzoom=15 --output=map.pmtiles
    # valhalla_build_config + valhalla_build_tiles + valhalla_build_extract

Publish:

    wrangler r2 object put flaxia-content/maps/<city>/map.pmtiles --file maps-packs/<city>/map.pmtiles
    wrangler r2 object put flaxia-content/maps/<city>/valhalla.tar --file maps-packs/<city>/valhalla.tar

The API serves packs from R2 at GET /api/maps/packs/:city/pmtiles and GET /api/maps/packs/:city/valhalla with HTTP Range support and immutable caching. GET /api/maps/cities reports the curated cities and world low-zoom status.

## Global gazetteer import

    node scripts/import-global-gazetteer.mjs
    D1_REMOTE=1 node scripts/import-global-gazetteer.mjs

This downloads GeoNames cities500 (about 185k cities worldwide) and loads them into maps_places. Run once, then refresh monthly.

## API

- GET /api/maps/cities — curated city manifest plus world low-zoom status
- GET /api/maps/geocode?q= — city/station search, worldwide after gazetteer import
- GET /api/maps/weather?lat=&lon= — point weather from MET Norway, cached
- GET /api/maps/packs/:city/pmtiles — city map tiles (Range), any city slug
- GET /api/maps/packs/:city/valhalla — city routing tiles (Range), any city slug

All endpoints are rate-limited per IP and need no API key.

## Limits

- City-level geocoding only, no street addresses.
- Routing is per-city only. Long-distance or rural routing is out of scope for the $0 build.
- No live traffic and no high-resolution weather raster at $0.
- Pack updates are monthly; tiles are versioned and immutable.
