# Vindy — a Windy-style weather map for Denmark

Interactive weather map built only on:

- **DMI Open Data** (no API key needed)
  - HARMONIE DINI surface forecast (GRIB files, read with HTTP range requests so only the needed slice is downloaded): full 2 km detail over Denmark, blended into a 6 km version over 6°W–28°E / 48–65°N (the same area used for fronts). Layers: wind, gusts, rain, temperature, dew point, clouds, low clouds, pressure with isobars, humidity, visibility, CAPE
  - WAM Danish Waters wave model: significant wave height and direction
  - metObs: live observations from DMI stations
  - HARMONIE DINI pressure levels: 850 hPa wet-bulb potential temperature and wind, used to derive weather fronts automatically (thermal front parameter). These are computed from the model, not DMI's hand-drawn analysis
  - Forecast EDR API: point forecasts (falls back to the GRIB files when DMI rate-limits)
- **EUMETNET OPERA** European radar composite (EURADCOM, CC BY 4.0): last 3 hours of 5-minute max reflectivity frames

Basemap tiles are Esri Dark Gray Canvas; coastlines and borders come from GSHHG: a simplified overview (`public/data/coast.json`) and full resolution from zoom 8 (tiles in `public/data/coast`), both built with `tools/build_coast_tiles.py`. They are drawn dark above the weather data, with a shadow on the water side (`public/js/coast-layer.js`), which relies on the build script orienting every shoreline with water on its left. The same layer draws Danish region borders (from zoom 7) and municipality borders (from zoom 9). The Danish borders are built from Dataforsyningen's open DAGI data with `tools/build_admin.py` into `public/data/admin.json`, which the map loads the first time it is zoomed in far enough; only borders between two areas are kept, so the coast isn't drawn twice. Location search uses Dataforsyningen (Danish place names and addresses) and OpenStreetMap Photon.

## Run with Docker (recommended for a server)

```bash
docker compose up -d --build
```

The app is then available on port 5173 (`http://your-server:5173`). The first start indexes the latest DMI model run and pre-computes isobars and fronts; expect the map to be ready after about 30 seconds and all hours of fronts to be available after 1–2 minutes.

- Data cache: stored in the `vindy-cache` volume (`/data/cache` in the container, about 350 MB, briefly up to ~700 MB while a new run is prepared; old model runs are deleted automatically).
- Change the port: edit `ports` in `docker-compose.yml` (e.g. `"8080:5173"`).
- Logs: `docker compose logs -f vindy`
- Update after changing the code: `docker compose up -d --build`
- Health check: the container is marked unhealthy if `/api/meta` stops responding.
- Model updates run on a timer, never triggered by visitors: every 10 minutes the server checks DMI for a new run. A new run is prepared completely in the background while visitors keep getting the previous run; the server switches only when every step succeeded (otherwise it keeps the old run and retries the missing pieces 10 minutes later), then deletes the old run from disk and memory. Visitor requests take priority over the preparation. The active runs are recorded in `state.json` in the cache, so after a restart or `docker compose up -d --build` they are served again immediately.
- Pre-fetching (`PREFETCH` in `docker-compose.yml`): what is prepared for each run. Always isobars, fronts and accumulated rain for all hours; with the default `24h` also every layer for the next 24 hours (about 2 GB of DMI download per run, ~10 min of background work). `all` prepares every layer for all 61 hours (~5 GB per run); `off` only the essentials. Hours outside the window are prepared on first view.

For HTTPS and a domain name, put a reverse proxy in front, e.g. Caddy (HTTPS is also required to install Vindy as an app, except on `localhost`):

```
vejr.example.dk {
  reverse_proxy localhost:5173
}
```

Without Compose:

```bash
docker build -t vindy .
docker run -d --name vindy --restart unless-stopped --init -p 5173:5173 -v vindy-cache:/data vindy
```

## Run locally without Docker

```bash
npm install
npm start
```

Open http://localhost:5173. The first start indexes the latest DMI model run (~20 s); after that, data is cached in `.cache/`.

Set `PORT` to change the port and `CACHE_DIR` to move the cache.

## Using it

- Pick a layer on the right; drag the timeline or press play (space bar, ← →)
- Click anywhere for an hourly meteogram at that point; click a station for its latest observations
- Radar switches the timeline to the last 3 hours of observed frames
- Overlays (layer menu, collapsible via its header): particles (wind streaks / wave crests), observed DMI station values, forecast values at towns, a value grid, isobars with H/L, and weather fronts
- URLs name the layer and map view, e.g. `/wind/55.68,12.57,9` (layer, then latitude,longitude,zoom), so a view can be bookmarked or shared. `/radar` alone opens a layer at the default view; old `#layer,lat,lon,zoom` links are redirected.

## Install as an app (PWA)

Vindy is a Progressive Web App: in Chrome/Edge use *Installer Vindy som app* at the bottom of the layer menu (or the install icon in the address bar); on iPhone/iPad use *Share → Add to Home Screen* in Safari. The installed app opens full screen, has shortcuts for Radar, Vind and Regn, and its interface opens offline. Weather data is always loaded fresh from the server. Installation needs HTTPS (or `localhost`).

- `public/manifest.webmanifest`: name, colours, icons, shortcuts
- `public/sw.js`: service worker (app shell network-first with offline fallback; coastline tiles cached; `/api/*` never cached). Bump `VERSION` there to drop old caches.
- `public/img/icons/`: app icons (192/512, maskable 512, Apple touch icon 180)
