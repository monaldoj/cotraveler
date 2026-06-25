# Co-Traveler — H3 Spatiotemporal Proximity Explorer

<img width="2001" height="1184" alt="cotraveler-screenshot" src="https://github.com/user-attachments/assets/c8bd8738-7c1e-4339-b16e-5065a7be7d2e" />

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
├── notebooks/            # run these once to build + populate the tables
│   ├── 00 Foursquare Co-traveler Dataset Ingestion.ipynb
│   └── 01 Foursquare H3 Index Enrichment.ipynb
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

Backed by a Unity Catalog table `<catalog>.<schema>.checkins_h3` (plus a
`<catalog>.<schema>.pois` table for venue categories). The catalog and
schema are set via the `DATABRICKS_CATALOG` / `DATABRICKS_SCHEMA` env
vars (see below) — locally as exports, and for the deployed app as
values hardcoded in `app.yaml`. Point the app at a different workspace
by editing those two values in `app.yaml`.

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

### Build the tables first

The two tables the app reads (`checkins_h3` and `pois`) are built by the
notebooks in [`./notebooks`](./notebooks) — **run these once, in order,
before deploying the app:**

1. **`00 Foursquare Co-traveler Dataset Ingestion.ipynb`** — creates the
   schema + a volume, downloads the raw Foursquare files, and loads them
   into the `checkins_raw` and `pois` Delta tables.
2. **`01 Foursquare H3 Index Enrichment.ipynb`** — joins check-ins with
   POIs, computes the H3 cell ids at each resolution, derives
   `local_time`, and writes the final clustered `checkins_h3` table.

Both notebooks take `catalog` and `schema` widget values — set them to
the **same** catalog/schema you'll point the app at via
`DATABRICKS_CATALOG` / `DATABRICKS_SCHEMA` (below).

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
| `DATABRICKS_HOST` | yes\*\* | Workspace URL, e.g. `https://my-workspace.cloud.databricks.com`. Injected automatically in a deployed Databricks App. |
| `DATABRICKS_TOKEN` | local only | Personal Access Token for local dev. In a deployed Databricks App, auth is automatic (M2M OAuth) and this is **not** set. |
| `SQL_WAREHOUSE_HTTP_PATH` | yes\* | e.g. `/sql/1.0/warehouses/<id>`. The warehouse id is parsed from the tail. |
| `WAREHOUSE_ID` | yes\* | Alternative to the HTTP path — just the id, e.g. `abc123def456`. |
| `DATABRICKS_CATALOG` | local only | Unity Catalog catalog holding the tables. Set this when running locally; the deployed app hardcodes `justinm_demo` in `app.yaml`. Server default `main`. |
| `DATABRICKS_SCHEMA` | local only | Unity Catalog schema holding `checkins_h3` and `pois`. Set this when running locally; the deployed app hardcodes `cotraveler` in `app.yaml`. Server default `cotraveler`. |
| `CHECKINS_TABLE` | no | Override the full check-ins table name. Defaults to `<DATABRICKS_CATALOG>.<DATABRICKS_SCHEMA>.checkins_h3`. |
| `POIS_TABLE` | no | Override the full POIs table name. Defaults to `<DATABRICKS_CATALOG>.<DATABRICKS_SCHEMA>.pois`. |

\* Provide **either** `SQL_WAREHOUSE_HTTP_PATH` **or** `WAREHOUSE_ID`.

\*\* Required when running locally or deploying outside the bundle. The
Databricks Apps runtime injects `DATABRICKS_HOST` (and OAuth credentials)
automatically.

> **Setting catalog/schema.** Locally, export `DATABRICKS_CATALOG` +
> `DATABRICKS_SCHEMA`. For the deployed app they are hardcoded in
> `app.yaml` — edit them there to point at your workspace's tables. Only
> set `CHECKINS_TABLE` / `POIS_TABLE` directly if your two tables don't
> live under the same `catalog.schema`.

---

## Run locally

> **npm registry note:** The committed `package-lock.json` pins the public
> npm registry (`registry.npmjs.org`), so the Databricks Apps build installs
> with no extra config. On the Databricks corporate network the public
> registry is unreachable — set `NPM_CONFIG_REGISTRY` to the internal proxy
> for local installs (npm rewrites the lockfile hosts to the proxy at fetch
> time). Leave it unset everywhere else.
>
> ```bash
> export NPM_CONFIG_REGISTRY=https://npm-proxy.cloud.databricks.com/
> ```

```bash
cd cotraveler
npm install                 # set NPM_CONFIG_REGISTRY first if on the corp network

export DATABRICKS_HOST="https://my-workspace.cloud.databricks.com"
export DATABRICKS_TOKEN="dapi..."                       # your PAT
export SQL_WAREHOUSE_HTTP_PATH="/sql/1.0/warehouses/<your-warehouse-id>"
export DATABRICKS_CATALOG="justinm_demo"                # your catalog
export DATABRICKS_SCHEMA="cotraveler"                   # your schema

# Option 1 — production-style: build the SPA, serve everything from Express
npm run build
npm start                 # http://localhost:8000

# Option 2 — hot-reload dev: Vite frontend + Express backend together
npm start &               # backend on :8000
npm run dev               # frontend on :5173, proxies /api -> :8000
```

> Need an interactive Databricks login instead of a PAT? In this Claude
> Code session you can run `! databricks auth login --host https://my-workspace.cloud.databricks.com`
> and export the resulting token.

---

## Deploy as a Databricks App (Asset Bundle)

The repo ships a workspace-agnostic Databricks Asset Bundle
(`databricks.yml`) — every workspace-specific value is passed in at
deploy time, so there's nothing in the repo to edit.

**Before you start**, the Databricks CLI needs credentials for your
workspace. Set both in your local environment:

```bash
export DATABRICKS_HOST="https://my-workspace.cloud.databricks.com"
export DATABRICKS_TOKEN="dapi..."   # a PAT for that workspace
```

> Without these two, `databricks bundle deploy` can't authenticate and
> will fail. (Alternatively, `databricks auth login` + `--profile <name>`
> works too.)

Then deploy:

```bash
# 1. Build the frontend (the app serves dist/ — no build step on the app side)
npm install && npm run build

# 2. Deploy, passing your warehouse id
databricks bundle deploy -t dev \
  --var="warehouse_id=<your-warehouse-id>"

# 3. Start the app
databricks bundle run cotraveler -t dev
```

`warehouse_id` binds the SQL warehouse as a `CAN_USE` resource named
`sql-warehouse`; `app.yaml` reads its id at runtime via
`valueFrom: sql-warehouse` and exposes it as `WAREHOUSE_ID`. (App env
vars only deploy from `app.yaml` and resource bindings — *not* from a
bundle `config.env` block — so the warehouse id has to travel through
the binding.)

**Set the table location before deploying.** `DATABRICKS_CATALOG` and
`DATABRICKS_SCHEMA` have no resource to bind to, and `app.yaml` cannot
use `${var.*}` interpolation, so they are **hardcoded in `app.yaml`**
(defaults `justinm_demo` / `cotraveler`). To point the app at a
different catalog/schema, edit the `DATABRICKS_CATALOG` /
`DATABRICKS_SCHEMA` `value:` fields in `app.yaml` before deploying.

Targets are `dev` (default) and `prod` (use `-t prod` for a shared
production deploy under `/Workspace/Shared`).

**After the first deploy**, grant the app's service principal `SELECT`
on `<catalog>.<schema>.checkins_h3` and `<catalog>.<schema>.pois`. No
token is needed inside the deployed app — it authenticates via the
injected M2M OAuth credentials automatically.

---

## Tested SQL

Both core queries were validated against a live table
(90,048,627 rows, 2,733,324 users, 2012–2014) on a SQL warehouse:
viewport binning returns hexbins with GeoJSON boundaries, and the
proximity search for user `1085789` (radius 2 km, ± 48 h) returns
ranked co-traveler records by distance and time delta.
