// Thin fetch wrapper around the Express /api/* endpoints. Keeping
// all network calls here mirrors Repo A's separation between the
// view layer and the data layer.

// Query observer — endpoints that run SQL echo back the statement they
// executed (`sql`) and how long the warehouse took (`elapsedMs`). Any
// listener registered via api.onQuery is notified for each such call,
// so the UI can surface the live geospatial query when asked to.
const queryListeners = new Set()

function notifyQuery(url, data) {
  if (!data || data.sql == null) return
  const event = { endpoint: url.split('?')[0], sql: data.sql, elapsedMs: data.elapsedMs }
  for (const fn of queryListeners) {
    try { fn(event) } catch {}
  }
}

async function post(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  notifyQuery(url, data)
  return data
}

async function get(url) {
  const resp = await fetch(url)
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  notifyQuery(url, data)
  return data
}

export const api = {
  config: () => get('/api/config'),

  // Subscribe to executed SQL queries. Returns an unsubscribe fn.
  onQuery: (fn) => {
    queryListeners.add(fn)
    return () => queryListeners.delete(fn)
  },

  // A. Viewport H3 bins for the current map bounds + zoom.
  h3Bins: ({ north, south, east, west, zoom, maxCells }) =>
    post('/api/h3-bins', { north, south, east, west, zoom, maxCells }),

  // E. Venue-category breakdown for a clicked hexagon.
  hexCategories: ({ h3, zoom }) => post('/api/hex-categories', { h3, zoom }),

  // User ID autocomplete.
  users: (prefix) => get(`/api/users?prefix=${encodeURIComponent(prefix)}`),

  // F. Top users by check-in count within the viewport — sidebar
  // leaderboard (shown when no specific user is searched on).
  topUsers: ({ north, south, east, west, limit = 100 }) =>
    post('/api/top-users', { north, south, east, west, limit }),

  // G. All check-ins for the searched user-of-interest.
  userCheckins: (userId) => get(`/api/user-checkins?userId=${encodeURIComponent(userId)}`),

  // H. Aggregated co-traveler search across all (or a checkbox subset
  // via idxList) of the user-of-interest's check-ins.
  coTravelers: ({ userId, radiusKm, windowHours, idxList }) =>
    post('/api/co-travelers', { userId, radiusKm, windowHours, idxList }),

  // I. Per-match overlap detail — loaded when a match row expands.
  coTravelerOverlap: ({ userId, matchUserId, radiusKm, windowHours, idxList }) =>
    post('/api/co-traveler-overlap', { userId, matchUserId, radiusKm, windowHours, idxList }),

  // J. A matched co-traveler's own check-ins (all of them, with an
  // isHit flag) — overlaid on the map when a match row expands.
  coTravelerCheckins: ({ userId, matchUserId, radiusKm, windowHours, idxList }) =>
    post('/api/co-traveler-checkins', { userId, matchUserId, radiusKm, windowHours, idxList }),
}
