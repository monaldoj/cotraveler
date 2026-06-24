// Thin fetch wrapper around the Express /api/* endpoints. Keeping
// all network calls here mirrors Repo A's separation between the
// view layer and the data layer.

async function post(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

async function get(url) {
  const resp = await fetch(url)
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

export const api = {
  config: () => get('/api/config'),

  // A. Viewport H3 bins for the current map bounds + zoom.
  h3Bins: ({ north, south, east, west, zoom, maxCells }) =>
    post('/api/h3-bins', { north, south, east, west, zoom, maxCells }),

  // E. Venue-category breakdown for a clicked hexagon.
  hexCategories: ({ h3, zoom }) => post('/api/hex-categories', { h3, zoom }),

  // User ID autocomplete.
  users: (prefix) => get(`/api/users?prefix=${encodeURIComponent(prefix)}`),

  // B + C. Spatiotemporal proximity search.
  userSearch: ({ userId, radiusKm, windowHours, atTime }) =>
    post('/api/user-search', { userId, radiusKm, windowHours, atTime }),
}
