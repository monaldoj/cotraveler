# Co-Traveler — H3 Spatiotemporal Proximity Explorer

An interactive Databricks App that visualizes 90M+ Foursquare-style
check-ins as dynamic **H3 hexbins** on a Leaflet map, and runs
**spatiotemporal proximity searches** to find the "co-travelers" of a
given user — other records within a radius and time window of that
user's checkpoint.

All heavy spatial work (H3 indexing, kRing expansion, distance,
aggregation) runs **in Databricks SQL** using built-in H3 expressions.
The app only assembles parameterized statements and draws the results.

```
┌─────────────┐   /api/h3-bins        ┌──────────────┐   H3 SQL    ┌────────────┐
│  React +    │ ───────────────────▶  │  Express      │ ─────────▶  │ Databricks │
│  Leaflet    │   /api/user-search    │  (server.js)  │  REST API   │ SQL whouse │
│  (browser)  │ ◀───────────────────  │  + queries.js │ ◀─────────  │ checkins_h3│
└─────────────┘                       └──────────────┘             └────────────┘
```

This app blends:

- **Architecture & style of `anvil`** (Repo A): Node + Express server,
  the same `getToken()` auth ladder, the SQL Statement Execution REST
  API as the single Databricks seam, a Vite-built React SPA served from
  `dist/`, and the `app.yaml` + `resources` deployment pattern.
- **Geospatial features of the H3 viz app** (Repo B): H3 binning,
  viewport-driven re-aggregation, and H3-function-based proximity
  search.

---

## Project structure

```
cotraveler/
├── app.yaml              # Databricks App manifest (command, env, resources)
├── package.json          # node deps (express) + build deps (vite, react-leaflet)
├── server.js             # Express backend: auth ladder + /api/* endpoints
├── queries.js            # Parameterized H3 SQL builders (the data layer)
├── vite.config.js        # dev server + /api proxy + build config
├── index.html            # SPA entry
├── public/favicon.svg
├── src/
│   ├── main.jsx          # React bootstrap
│   ├── App.jsx           # layout + reactive state (viewport + search flows)
│   ├── api.js            # fetch wrapper for /api/*
│   ├── styles.css
│   └── components/
│       ├── Map.jsx       # Leaflet map, H3 hexbin layer, viewport callbacks
│       └── SearchPanel.jsx  # sidebar: User ID / Radius / Time Window
└── dist/                 # built frontend (created by `npm run build`)
```

> **Note on the SQL connector.** The original spec mentioned
> `databricks-sql-python`. That is a Python library and cannot run
> inside this Node/Express process (Repo A's chosen stack). To honor
> the *intent* — server-side, parameterized, H3-pushed-down queries —
> the data layer in `queries.js` emits **named-parameter** statements
> (`:name` markers + typed parameter arrays) executed through the SQL
> **Statement Execution REST API**, which is exactly how `anvil`
> talks to Databricks. The `query()`/`executeSql()` seam is isolated,
> so a Python port would swap only that one function for a
> `databricks.sql` cursor while keeping every SQL string intact.

---

## Data

Backed by the Unity Catalog table
[`justinm_demo.cotraveler.checkins_h3`](https://fevm-pubsec-ai.cloud.databricks.com/explore/data/justinm_demo/cotraveler/checkins_h3?o=7474660041786923).

| column | type | notes |
|---|---|---|
| `user_id` | string | |
| `venue_id` | string | |
| `utc_time` | string | original raw timestamp |
| `timezone_offset_minutes` | int | |
| `latitude`, `longitude` | double | |
| `venue_category_name` | string | |
| `country_code` | string | |
| `h3_r5`, `h3_r7`, `h3_r9`, `h3_r12` | bigint | precomputed H3 cell ids per resolution |
| `local_time` | timestamp | venue-local time |

The table is **clustered on `(user_id, h3_r9, local_time)`** — the
queries are written to ride that clustering (anchor lookup by
`user_id`, proximity prune by `h3_r9`, time-window filter on
`local_time`).

---

## How it works

### A. Viewport H3 binning (`/api/h3-bins`)
On every pan/zoom, `Map.jsx` emits the viewport bounds + zoom. `App.jsx`
debounces (~350 ms) and posts them. `viewportBinsQuery()` picks an H3
resolution for the zoom level, filters check-ins to the bounding box,
`GROUP BY`s the H3 cell, and returns each hexagon's `cnt` plus its
`h3_boundaryasgeojson(...)` polygon. The frontend draws the polygons
colored by a log-scaled density ramp.

### B + C. Spatiotemporal proximity search (`/api/user-search`)
1. **Anchor** — `userCheckpointQuery()` finds the user's checkpoint
   (latest check-in by default), including its H3 r9 cell.
2. **Expand** — `proximitySearchQuery()` turns the radius into a kRing
   size, `explode(h3_kring(anchor_cell, k))` into candidate cells.
3. **Join + filter** — equi-joins the table on `h3_r9 = candidate cell`
   (cheap, clustering-aligned prune), keeps rows inside the
   `± windowHours` time window, then refines to an exact radius with a
   haversine great-circle distance.
4. **Plot** — the anchor (pink), the search-radius ring, and the
   co-traveler matches (yellow) are overlaid on top of the hexbins.

> We deliberately avoid calling `h3_distance` across the whole table:
> it raises `H3_UNDEFINED_GRID_DISTANCE` for far-apart cells. The
> kRing equi-join is both correct and index-friendly.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABRICKS_HOST` | yes | Workspace URL, e.g. `https://fevm-pubsec-ai.cloud.databricks.com` |
| `DATABRICKS_TOKEN` | local only | Personal Access Token for local dev. In a deployed Databricks App, auth is automatic (M2M OAuth) and this is **not** set. |
| `SQL_WAREHOUSE_HTTP_PATH` | yes\* | e.g. `/sql/1.0/warehouses/c6881915e0a8c7c6`. The warehouse id is parsed from the tail. |
| `WAREHOUSE_ID` | yes\* | Alternative to the HTTP path — just the id, e.g. `c6881915e0a8c7c6`. |
| `CHECKINS_TABLE` | no | Override the source table (default `justinm_demo.cotraveler.checkins_h3`). |

\* Provide **either** `SQL_WAREHOUSE_HTTP_PATH` **or** `WAREHOUSE_ID`.

For the target workspace the running warehouse is **`ai-wh`**
(`c6881915e0a8c7c6`), HTTP path `/sql/1.0/warehouses/c6881915e0a8c7c6`.

---

## Run locally

```bash
cd cotraveler
npm install

export DATABRICKS_HOST="https://fevm-pubsec-ai.cloud.databricks.com"
export DATABRICKS_TOKEN="dapi..."                       # your PAT
export SQL_WAREHOUSE_HTTP_PATH="/sql/1.0/warehouses/c6881915e0a8c7c6"

# Option 1 — production-style: build the SPA, serve everything from Express
npm run build
npm start                 # http://localhost:8000

# Option 2 — hot-reload dev: Vite frontend + Express backend together
npm start &               # backend on :8000
npm run dev               # frontend on :5173, proxies /api -> :8000
```

> Need an interactive Databricks login instead of a PAT? In this Claude
> Code session you can run `! databricks auth login --host https://fevm-pubsec-ai.cloud.databricks.com`
> and export the resulting token.

---

## Deploy as a Databricks App

1. **Build the frontend** (the App runs `node server.js`, which serves
   `dist/` — there is no build step on the App side):
   ```bash
   npm install && npm run build
   ```

2. **Sync the folder** to your workspace and create the app:
   ```bash
   databricks sync . /Workspace/Users/<you>/cotraveler --watch
   databricks apps create cotraveler
   databricks apps deploy cotraveler \
     --source-code-path /Workspace/Users/<you>/cotraveler
   ```
   (Or use the **Apps** UI: New App → from workspace folder.)

3. **`app.yaml`** already declares the entrypoint, env, and the
   warehouse resource. Grant the app's service principal `CAN_USE` on
   the warehouse and `SELECT` on `justinm_demo.cotraveler.checkins_h3`.
   No token is needed in the deployed app — `getToken()` uses the
   injected `DATABRICKS_CLIENT_ID`/`DATABRICKS_CLIENT_SECRET` to fetch
   an M2M OAuth token automatically.

```yaml
command:
  - node
  - server.js

env:
  - name: WAREHOUSE_ID
    value: c6881915e0a8c7c6
  - name: CHECKINS_TABLE
    value: justinm_demo.cotraveler.checkins_h3

resources:
  - name: sql-warehouse
    sql_warehouse:
      id: c6881915e0a8c7c6
      permission: CAN_USE
```

---

## Tested SQL

Both core queries were validated against the live table
(90,048,627 rows, 2,733,324 users, 2012–2014) on the `ai-wh` warehouse:
viewport binning returns hexbins with GeoJSON boundaries, and the
proximity search for user `1085789` (radius 2 km, ± 48 h) returns
ranked co-traveler records by distance and time delta.
