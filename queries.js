// ============================================================
// queries.js — Parameterized H3 SQL for the Co-Traveler app
//
// All heavy spatial lifting happens on the Databricks SQL
// warehouse using built-in H3 expressions (h3_longlatash3,
// h3_kring, h3_distance, h3_boundaryasgeojson). The Node layer
// only assembles statements and shapes results.
//
// Connector style mirrors Repo A (anvil): we go through the SQL
// Statement Execution REST API rather than a native driver, so
// the same auth + warehouse pattern is reused everywhere. The
// `query()` helper below is the single seam — swap it for the
// databricks-sql driver in a Python port without touching the
// SQL strings.
// ============================================================

// Fully-qualified Unity Catalog table backing every query.
export const CHECKINS_TABLE =
  process.env.CHECKINS_TABLE || 'justinm_demo.cotraveler.checkins_h3'

// Points-of-interest table: one row per venue_id with its category.
// Joined to the check-ins on venue_id so a hexagon can be broken down
// by the venue categories its check-ins belong to.
export const POIS_TABLE =
  process.env.POIS_TABLE || 'justinm_demo.cotraveler.pois'

// H3 resolution used for each map zoom band. Lower zoom => coarser
// hexagons (smaller resolution number) so the bin count stays sane.
// The table is physically clustered on h3_r9, so resolutions at or
// below 9 prune well; higher zooms fall back to r9 + lat/lon.
export function resolutionForZoom(zoom) {
  if (zoom <= 4) return { res: 3, col: null }   // continental
  if (zoom <= 6) return { res: 5, col: 'h3_r5' }
  if (zoom <= 9) return { res: 7, col: 'h3_r7' }
  if (zoom <= 12) return { res: 9, col: 'h3_r9' }
  return { res: 12, col: 'h3_r12' }              // street level
}

// ------------------------------------------------------------
// Parameter binding
//
// The SQL Statement Execution API takes named markers (:name) plus
// a typed `parameters` array — that is the safe, injection-proof
// path, exactly like databricks-sql cursor params. Each builder
// below returns { statement, parameters } ready to POST.
// ------------------------------------------------------------
function param(name, value, type = 'STRING') {
  return { name, value: String(value), type }
}

// ============================================================
// A. Viewport H3 binning
//
// Given the map's bounding box (N/S/E/W) and zoom, aggregate the
// points that fall inside the viewport into H3 hexagons and return
// each hexagon's GeoJSON boundary + count. The boundary is emitted
// directly by Databricks (h3_boundaryasgeojson) so the frontend
// just draws polygons — no client-side H3 library required.
// ============================================================
export function viewportBinsQuery({ north, south, east, west, zoom, maxCells = 2000 }) {
  const { res, col } = resolutionForZoom(zoom)

  // When a pre-computed H3 column exists for this resolution we GROUP
  // BY it (cheap, hits the clustering key). Otherwise compute the cell
  // on the fly with h3_longlatash3(lng, lat, res).
  const cellExpr = col ? col : `h3_longlatash3(longitude, latitude, ${res})`

  const statement = `
    WITH viewport AS (
      SELECT ${col ? col : 'latitude, longitude'}
      FROM ${CHECKINS_TABLE}
      WHERE latitude  BETWEEN :south AND :north
        AND longitude BETWEEN :west  AND :east
    ),
    binned AS (
      SELECT ${cellExpr} AS cell, COUNT(*) AS cnt
      FROM viewport
      GROUP BY ${cellExpr}
      ORDER BY cnt DESC
      LIMIT :maxCells
    )
    SELECT
      h3_h3tostring(cell)          AS h3,
      h3_boundaryasgeojson(cell)   AS boundary,
      cnt
    FROM binned
  `

  return {
    statement,
    parameters: [
      param('south', south, 'DOUBLE'),
      param('north', north, 'DOUBLE'),
      param('west', west, 'DOUBLE'),
      param('east', east, 'DOUBLE'),
      param('maxCells', maxCells, 'INT'),
    ],
  }
}

// ============================================================
// B. User checkpoint lookup
//
// Step 1 of the proximity search: find the anchor location +
// timestamp for a user. By default we use that user's most recent
// check-in; an optional `atTime` snaps to the check-in closest to a
// chosen instant so the search can be re-centered in time.
// ============================================================
export function userCheckpointQuery({ userId, atTime = null }) {
  const orderBy = atTime
    ? 'ORDER BY ABS(TIMESTAMPDIFF(SECOND, local_time, :atTime))'
    : 'ORDER BY local_time DESC'

  const statement = `
    SELECT
      user_id,
      latitude,
      longitude,
      local_time,
      venue_category_name,
      country_code,
      h3_h3tostring(h3_r9) AS anchor_h3
    FROM ${CHECKINS_TABLE}
    WHERE user_id = :userId
    ${orderBy}
    LIMIT 1
  `

  const parameters = [param('userId', userId)]
  if (atTime) parameters.push(param('atTime', atTime, 'TIMESTAMP'))
  return { statement, parameters }
}

// ============================================================
// C. Spatiotemporal proximity search ("co-travelers")
//
// Steps 2–4: anchor the search on the user's checkpoint, expand a
// kRing of H3 cells around it (coarse spatial prune that rides the
// h3_r9 clustering key), join the full table on those cells, keep
// only rows inside the time window, then refine to an exact radius
// with the haversine great-circle distance.
//
// We deliberately do NOT call h3_distance across the whole table:
// it throws H3_UNDEFINED_GRID_DISTANCE for far-apart cells. The
// kRing equi-join is both safe and index-friendly.
// ============================================================

// Approx. edge length (km) of an H3 r9 hexagon, used to translate a
// radius in km into a kRing of integer ring steps for the prune.
const H3_R9_EDGE_KM = 0.174

export function proximitySearchQuery({
  userId,
  radiusKm,
  windowHours,
  atTime = null,
  limit = 500,
}) {
  // Convert the requested radius into a kRing size, padded by one
  // ring so the cheap hex prune never clips points the exact
  // haversine filter would keep.
  const k = Math.max(1, Math.ceil(radiusKm / H3_R9_EDGE_KM) + 1)

  // Anchor selection mirrors userCheckpointQuery so "search" and the
  // marker we drop on the map always agree.
  const anchorOrder = atTime
    ? 'ORDER BY ABS(TIMESTAMPDIFF(SECOND, local_time, :atTime))'
    : 'ORDER BY local_time DESC'

  const statement = `
    WITH anchor AS (
      SELECT
        user_id,
        latitude  AS a_lat,
        longitude AS a_lon,
        local_time AS a_time,
        h3_r9      AS anchor_cell
      FROM ${CHECKINS_TABLE}
      WHERE user_id = :userId
      ${anchorOrder}
      LIMIT 1
    ),
    -- Expand the anchor cell into its kRing — one row per candidate cell.
    ring AS (
      SELECT a.*, explode(h3_kring(a.anchor_cell, :k)) AS cell
      FROM anchor a
    ),
    -- Join the table on the candidate cells + time window, then
    -- compute the exact great-circle distance to the anchor.
    candidates AS (
      SELECT
        c.user_id,
        c.venue_id,
        c.venue_category_name,
        c.latitude,
        c.longitude,
        c.local_time,
        h3_h3tostring(c.h3_r9) AS h3,
        2 * 6371 * ASIN(SQRT(
          POWER(SIN(RADIANS(c.latitude - r.a_lat) / 2), 2) +
          COS(RADIANS(r.a_lat)) * COS(RADIANS(c.latitude)) *
          POWER(SIN(RADIANS(c.longitude - r.a_lon) / 2), 2)
        )) AS dist_km,
        ABS(TIMESTAMPDIFF(MINUTE, c.local_time, r.a_time)) AS minutes_apart
      FROM ring r
      JOIN ${CHECKINS_TABLE} c
        ON c.h3_r9 = r.cell
      WHERE c.user_id <> r.user_id
        AND c.local_time BETWEEN r.a_time - MAKE_INTERVAL(0,0,0,0,:win,0,0)
                             AND r.a_time + MAKE_INTERVAL(0,0,0,0,:win,0,0)
    )
    SELECT
      user_id,
      venue_id,
      venue_category_name,
      latitude,
      longitude,
      local_time,
      h3,
      ROUND(dist_km, 3)  AS dist_km,
      minutes_apart
    FROM candidates
    WHERE dist_km <= :radiusKm
    ORDER BY dist_km, minutes_apart
    LIMIT :limit
  `

  return {
    statement,
    parameters: [
      param('userId', userId),
      param('k', k, 'INT'),
      param('win', windowHours, 'INT'),
      param('radiusKm', radiusKm, 'DOUBLE'),
      param('limit', limit, 'INT'),
      ...(atTime ? [param('atTime', atTime, 'TIMESTAMP')] : []),
    ],
  }
}

// ============================================================
// D. User ID autocomplete
//
// Powers the sidebar dropdown — a cheap prefix match so an analyst
// can pick a real user_id instead of guessing one.
// ============================================================
// ============================================================
// E. Hexagon venue-category breakdown
//
// When an analyst clicks a hexagon we re-open just that cell and
// break its check-ins down by venue category. The categories live on
// the POIs table, so we join check-ins -> pois on venue_id and group.
//
// The cell is identified by the same h3 string the bin layer drew,
// plus the zoom that produced it (so we filter on the matching
// resolution). Pre-computed columns (h3_r5/r7/r9/r12) ride the
// clustering key; coarser zooms with no column recompute the cell on
// the fly with h3_longlatash3, exactly like viewportBinsQuery.
// ============================================================
export function hexCategoriesQuery({ h3, zoom, limit = 25 }) {
  const { res, col } = resolutionForZoom(zoom)
  const cellExpr = col ? `c.${col}` : `h3_longlatash3(c.longitude, c.latitude, ${res})`

  const statement = `
    SELECT
      p.venue_category_name AS category,
      COUNT(*)              AS cnt
    FROM ${CHECKINS_TABLE} c
    JOIN ${POIS_TABLE} p
      ON c.venue_id = p.venue_id
    WHERE ${cellExpr} = h3_stringtoh3(:h3)
    GROUP BY p.venue_category_name
    ORDER BY cnt DESC, category
    LIMIT :limit
  `

  return {
    statement,
    parameters: [
      param('h3', h3),
      param('limit', limit, 'INT'),
    ],
  }
}

export function userSuggestQuery({ prefix, limit = 20 }) {
  const statement = `
    SELECT user_id, COUNT(*) AS checkins
    FROM ${CHECKINS_TABLE}
    WHERE user_id LIKE :prefix
    GROUP BY user_id
    ORDER BY checkins DESC
    LIMIT :limit
  `
  return {
    statement,
    parameters: [
      param('prefix', `${prefix}%`),
      param('limit', limit, 'INT'),
    ],
  }
}
