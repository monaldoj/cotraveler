import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'

import {
  CHECKINS_TABLE,
  viewportBinsQuery,
  hexCategoriesQuery,
  userCheckpointQuery,
  proximitySearchQuery,
  userSuggestQuery,
} from './queries.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8000

// Databricks workspace host — normalized to include the scheme.
const rawHost = process.env.DATABRICKS_HOST || 'https://fevm-pubsec-ai.cloud.databricks.com'
const DB_HOST = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`

// Warehouse that runs the H3 SQL. Prefer WAREHOUSE_ID; otherwise
// derive it from a classic SQL_WAREHOUSE_HTTP_PATH like
// /sql/1.0/warehouses/<id> so either env var works.
const WAREHOUSE_ID =
  process.env.WAREHOUSE_ID ||
  (process.env.SQL_WAREHOUSE_HTTP_PATH || '').split('/').pop() ||
  'c6881915e0a8c7c6'

// ------------------------------------------------------------
// Auth — Databricks Apps uses M2M OAuth; locally we accept a PAT.
// Same token ladder as Repo A (anvil): PAT -> cached OAuth ->
// client_credentials exchange -> mounted token file.
// ------------------------------------------------------------
let cachedToken = null
let tokenExpiry = 0

async function getToken() {
  // Method 1: explicit PAT (local dev)
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN

  // Method 2: cached OAuth token (valid ~1 hour)
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken

  // Method 3: M2M OAuth client_credentials exchange (Databricks Apps)
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    try {
      const resp = await fetch(`${DB_HOST}/oidc/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.DATABRICKS_CLIENT_ID,
          client_secret: process.env.DATABRICKS_CLIENT_SECRET,
          scope: 'all-apis',
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        cachedToken = data.access_token
        tokenExpiry = Date.now() + (data.expires_in - 60) * 1000 // refresh 1 min early
        console.log('OAuth token acquired, expires in', data.expires_in, 'seconds')
        return cachedToken
      }
      console.error('OAuth token exchange failed:', resp.status, await resp.text())
    } catch (err) {
      console.error('OAuth error:', err.message)
    }
  }

  // Method 4: mounted token file
  for (const p of ['/var/run/secrets/databricks/token', '/databricks/.databricks/token']) {
    try { if (existsSync(p)) return readFileSync(p, 'utf-8').trim() } catch {}
  }

  return null
}

// ------------------------------------------------------------
// SQL Statement Execution API — single seam to Databricks.
// Accepts named-parameter markers (:name) + typed parameters,
// exactly like the databricks-sql cursor params. Returns rows as
// an array of objects keyed by column name.
// ------------------------------------------------------------
async function executeSql({ statement, parameters = [] }, token) {
  const resp = await fetch(`${DB_HOST}/api/2.0/sql/statements/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: WAREHOUSE_ID,
      statement,
      parameters,
      wait_timeout: '30s',
      format: 'JSON_ARRAY',
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`SQL HTTP ${resp.status}: ${text.slice(0, 300)}`)
  }

  const data = await resp.json()
  if (data.status?.state !== 'SUCCEEDED') {
    const msg = data.status?.error?.message || JSON.stringify(data.status)
    throw new Error(`SQL state ${data.status?.state}: ${msg?.slice?.(0, 300) || msg}`)
  }

  const columns = data.manifest?.schema?.columns?.map((c) => c.name) || []
  const rows = (data.result?.data_array || []).map((row) => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
  return rows
}

app.use(express.json())
// Serve the built React app from dist/ (same as Repo A).
app.use(express.static(path.join(__dirname, 'dist')))

// ============================================================
// API
// ============================================================

// Health + config probe — lets the frontend know the table/host
// and whether we have a live warehouse connection.
app.get('/api/config', async (req, res) => {
  const token = await getToken()
  res.json({
    table: CHECKINS_TABLE,
    host: DB_HOST,
    warehouseId: WAREHOUSE_ID,
    connected: Boolean(token),
  })
})

// A. Viewport H3 bins — called on every pan/zoom.
app.post('/api/h3-bins', async (req, res) => {
  const { north, south, east, west, zoom, maxCells } = req.body || {}
  if ([north, south, east, west, zoom].some((v) => v == null)) {
    return res.status(400).json({ error: 'north, south, east, west, zoom required' })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const q = viewportBinsQuery({ north, south, east, west, zoom, maxCells })
    const rows = await executeSql(q, token)
    // Parse each hexagon's GeoJSON boundary once, server-side.
    const bins = rows.map((r) => ({
      h3: r.h3,
      count: Number(r.cnt),
      boundary: JSON.parse(r.boundary),
    }))
    res.json({ bins, zoom })
  } catch (err) {
    console.error('h3-bins error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// E. Venue-category breakdown for a single clicked hexagon.
app.post('/api/hex-categories', async (req, res) => {
  const { h3, zoom } = req.body || {}
  if (!h3 || zoom == null) {
    return res.status(400).json({ error: 'h3 and zoom required' })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const rows = await executeSql(hexCategoriesQuery({ h3, zoom }), token)
    const categories = rows.map((r) => ({
      category: r.category || 'Uncategorized',
      count: Number(r.cnt),
    }))
    const total = categories.reduce((sum, c) => sum + c.count, 0)
    res.json({ h3, categories, total })
  } catch (err) {
    console.error('hex-categories error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// User ID autocomplete for the sidebar dropdown.
app.get('/api/users', async (req, res) => {
  const prefix = (req.query.prefix || '').toString()
  if (!prefix) return res.json({ users: [] })
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const rows = await executeSql(userSuggestQuery({ prefix }), token)
    res.json({ users: rows.map((r) => ({ userId: r.user_id, checkins: Number(r.checkins) })) })
  } catch (err) {
    console.error('users error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// B + C. Spatiotemporal proximity search.
// Returns the anchor checkpoint and the proximal co-traveler records.
app.post('/api/user-search', async (req, res) => {
  const { userId, radiusKm = 1.0, windowHours = 24, atTime = null, limit = 500 } = req.body || {}
  if (!userId) return res.status(400).json({ error: 'userId required' })
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    // Step 1–2: resolve the anchor checkpoint (and its H3 index).
    const [anchor] = await executeSql(userCheckpointQuery({ userId, atTime }), token)
    if (!anchor) return res.json({ anchor: null, matches: [] })

    // Step 3: spatiotemporal kRing + radius + time-window search.
    const matches = await executeSql(
      proximitySearchQuery({ userId, radiusKm, windowHours, atTime, limit }),
      token,
    )

    // Step 4: shape for the map. Distinct payload from H3 bins so the
    // frontend can style proximal points differently.
    res.json({
      anchor: {
        userId: anchor.user_id,
        lat: Number(anchor.latitude),
        lon: Number(anchor.longitude),
        time: anchor.local_time,
        venue: anchor.venue_category_name,
        country: anchor.country_code,
        h3: anchor.anchor_h3,
      },
      params: { radiusKm, windowHours },
      matches: matches.map((m) => ({
        userId: m.user_id,
        venueId: m.venue_id,
        venue: m.venue_category_name,
        lat: Number(m.latitude),
        lon: Number(m.longitude),
        time: m.local_time,
        h3: m.h3,
        distKm: Number(m.dist_km),
        minutesApart: Number(m.minutes_apart),
      })),
    })
  } catch (err) {
    console.error('user-search error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// SPA fallback — serve index.html for all non-API routes.
app.get('{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`CO-TRAVELER server running on port ${PORT}`)
  console.log(`  table:     ${CHECKINS_TABLE}`)
  console.log(`  warehouse: ${WAREHOUSE_ID}`)

  // Warm the warehouse so the first map query is fast (mirrors anvil).
  setTimeout(async () => {
    const token = await getToken()
    if (!token) { console.log('No token — running without live data'); return }
    try {
      await executeSql({ statement: 'SELECT 1', parameters: [] }, token)
      console.log('SQL warehouse warm')
    } catch (err) { console.error('Warehouse warmup failed:', err.message) }
  }, 1000)
})
