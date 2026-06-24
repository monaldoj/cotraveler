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

// ============================================================
// F. Top users by check-in count
//
// Powers the sidebar leaderboard rendered on load. The full table has
// millions of distinct users, so we only ever return the densest few
// hundred — enough to browse without dragging the whole dimension to
// the client.
// ============================================================
export function topUsersQuery({ limit = 100 }) {
  const statement = `
    SELECT user_id, COUNT(*) AS checkins
    FROM ${CHECKINS_TABLE}
    GROUP BY user_id
    ORDER BY checkins DESC, user_id
    LIMIT :limit
  `
  return {
    statement,
    parameters: [param('limit', limit, 'INT')],
  }
}

// ------------------------------------------------------------
// Canonical ordering for a single user's check-ins.
//
// Every query that numbers a user's check-ins (the list shown in the
// sidebar, the aggregated co-traveler search, the per-match overlap
// detail) MUST use this exact ORDER BY. The integer ROW_NUMBER it
// produces ("idx") is the contract: the frontend sends back a subset
// of idx values via the checkboxes, and the search re-derives the same
// numbering to pick which check-ins to anchor on. Change this in one
// place and the others drift out of alignment.
// ------------------------------------------------------------
const CHECKIN_ORDER = 'local_time DESC, venue_id, latitude, longitude'

// ============================================================
// G. Individual check-ins for one user
//
// Drives the "user-of-interest" list in the sidebar. The idx is a
// stable 1-based number over ALL of the user's check-ins (the window
// runs over the full partition), so even though we only return the
// first `limit` rows the numbering matches the search query's anchors.
// venue_category_name lives on the check-ins table directly, so no
// POIs join is needed.
// ============================================================
export function userCheckinsQuery({ userId, limit = 500 }) {
  const statement = `
    SELECT
      ROW_NUMBER() OVER (ORDER BY ${CHECKIN_ORDER}) AS idx,
      local_time,
      venue_category_name,
      country_code,
      latitude,
      longitude,
      h3_h3tostring(h3_r9) AS h3
    FROM ${CHECKINS_TABLE}
    WHERE user_id = :userId
    QUALIFY idx <= :limit
    ORDER BY idx
  `
  return {
    statement,
    parameters: [
      param('userId', userId),
      param('limit', limit, 'INT'),
    ],
  }
}

// ============================================================
// H. Aggregated co-traveler search
//
// The core of the redesigned search. Instead of anchoring on a single
// checkpoint, we anchor on MANY of the user-of-interest's check-ins at
// once and aggregate the matches per other user_id.
//
//   1. Number the user's check-ins with the canonical ordering.
//   2. Keep the anchors the analyst selected — either an explicit
//      subset of idx values (the checkboxes) or, by default, the first
//      `maxAnchors` of them.
//   3. kRing-expand every anchor cell, equi-join the table on those
//      cells inside each anchor's own time window, refine to the exact
//      radius.
//   4. GROUP BY the other user_id: hits = total proximate check-ins,
//      stops = how many DISTINCT anchors of the user-of-interest they
//      came near. Order by hits so the most-frequent co-travelers rise.
//
// `idxList` is an array of integers; when present we filter anchors to
// exactly those. It is interpolated (not bound) because the SQL
// Statement API has no array parameter type — values are integers we
// generate, never user text, so there is no injection surface.
// ============================================================
export function coTravelersAggQuery({
  userId,
  radiusKm,
  windowHours,
  idxList = null,
  maxAnchors = 2000,
  limit = 200,
}) {
  const k = Math.max(1, Math.ceil(radiusKm / H3_R9_EDGE_KM) + 1)

  // Anchor selection: an explicit checkbox subset, or the first N.
  const anchorFilter =
    idxList && idxList.length
      ? `WHERE idx IN (${idxList.map((n) => parseInt(n, 10)).filter(Number.isFinite).join(',')})`
      : `ORDER BY idx LIMIT ${parseInt(maxAnchors, 10)}`

  const statement = `
    WITH numbered AS (
      SELECT
        latitude, longitude, local_time, h3_r9,
        ROW_NUMBER() OVER (ORDER BY ${CHECKIN_ORDER}) AS idx
      FROM ${CHECKINS_TABLE}
      WHERE user_id = :userId
    ),
    anchors AS (
      SELECT
        latitude  AS a_lat,
        longitude AS a_lon,
        local_time AS a_time,
        h3_r9      AS anchor_cell,
        idx        AS anchor_idx
      FROM numbered
      ${anchorFilter}
    ),
    ring AS (
      SELECT a.*, explode(h3_kring(a.anchor_cell, :k)) AS cell
      FROM anchors a
    ),
    candidates AS (
      SELECT
        c.user_id,
        a.anchor_idx,
        2 * 6371 * ASIN(SQRT(
          POWER(SIN(RADIANS(c.latitude - a.a_lat) / 2), 2) +
          COS(RADIANS(a.a_lat)) * COS(RADIANS(c.latitude)) *
          POWER(SIN(RADIANS(c.longitude - a.a_lon) / 2), 2)
        )) AS dist_km,
        ABS(TIMESTAMPDIFF(MINUTE, c.local_time, a.a_time)) AS minutes_apart
      FROM ring a
      JOIN ${CHECKINS_TABLE} c
        ON c.h3_r9 = a.cell
      WHERE c.user_id <> :userId
        AND c.local_time BETWEEN a.a_time - MAKE_INTERVAL(0,0,0,0,:win,0,0)
                             AND a.a_time + MAKE_INTERVAL(0,0,0,0,:win,0,0)
    )
    SELECT
      user_id,
      COUNT(*)                   AS hits,
      COUNT(DISTINCT anchor_idx) AS stops,
      ROUND(MIN(dist_km), 3)     AS nearest_km,
      MIN(minutes_apart)         AS closest_min
    FROM candidates
    WHERE dist_km <= :radiusKm
    GROUP BY user_id
    ORDER BY hits DESC, stops DESC, nearest_km
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
    ],
  }
}

// ============================================================
// I. Per-match overlap detail
//
// Loaded lazily when an analyst expands one matched co-traveler. Shows
// WHICH of the user-of-interest's check-ins that co-traveler came near
// — the anchor's time + venue, the nearest distance, and the closest
// time gap. Mirrors the anchor selection of coTravelersAggQuery so the
// detail always reflects the same search the row came from.
// ============================================================
export function coTravelerOverlapQuery({
  userId,
  matchUserId,
  radiusKm,
  windowHours,
  idxList = null,
  maxAnchors = 2000,
  limit = 100,
}) {
  const k = Math.max(1, Math.ceil(radiusKm / H3_R9_EDGE_KM) + 1)

  const anchorFilter =
    idxList && idxList.length
      ? `WHERE idx IN (${idxList.map((n) => parseInt(n, 10)).filter(Number.isFinite).join(',')})`
      : `ORDER BY idx LIMIT ${parseInt(maxAnchors, 10)}`

  const statement = `
    WITH numbered AS (
      SELECT
        latitude, longitude, local_time, h3_r9, venue_category_name,
        ROW_NUMBER() OVER (ORDER BY ${CHECKIN_ORDER}) AS idx
      FROM ${CHECKINS_TABLE}
      WHERE user_id = :userId
    ),
    anchors AS (
      SELECT
        latitude  AS a_lat,
        longitude AS a_lon,
        local_time AS a_time,
        h3_r9      AS anchor_cell,
        idx        AS anchor_idx
      FROM numbered
      ${anchorFilter}
    ),
    ring AS (
      SELECT a.*, explode(h3_kring(a.anchor_cell, :k)) AS cell
      FROM anchors a
    ),
    candidates AS (
      SELECT
        a.anchor_idx,
        2 * 6371 * ASIN(SQRT(
          POWER(SIN(RADIANS(c.latitude - a.a_lat) / 2), 2) +
          COS(RADIANS(a.a_lat)) * COS(RADIANS(c.latitude)) *
          POWER(SIN(RADIANS(c.longitude - a.a_lon) / 2), 2)
        )) AS dist_km,
        ABS(TIMESTAMPDIFF(MINUTE, c.local_time, a.a_time)) AS minutes_apart
      FROM ring a
      JOIN ${CHECKINS_TABLE} c
        ON c.h3_r9 = a.cell
      WHERE c.user_id = :matchUserId
        AND c.local_time BETWEEN a.a_time - MAKE_INTERVAL(0,0,0,0,:win,0,0)
                             AND a.a_time + MAKE_INTERVAL(0,0,0,0,:win,0,0)
    )
    SELECT
      n.idx,
      n.local_time          AS anchor_time,
      n.venue_category_name AS anchor_venue,
      ROUND(MIN(cand.dist_km), 3) AS nearest_km,
      MIN(cand.minutes_apart)     AS closest_min,
      COUNT(*)                    AS encounters
    FROM candidates cand
    JOIN numbered n ON n.idx = cand.anchor_idx
    WHERE cand.dist_km <= :radiusKm
    GROUP BY n.idx, n.local_time, n.venue_category_name
    ORDER BY closest_min, nearest_km
    LIMIT :limit
  `

  return {
    statement,
    parameters: [
      param('userId', userId),
      param('matchUserId', matchUserId),
      param('k', k, 'INT'),
      param('win', windowHours, 'INT'),
      param('radiusKm', radiusKm, 'DOUBLE'),
      param('limit', limit, 'INT'),
    ],
  }
}
