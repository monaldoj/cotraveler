// ============================================================
// components/Map.jsx — Leaflet map + viewport state tracking
//
// Responsibilities:
//   1. Render the base tiles.
//   2. Draw the H3 hexbin layer (GeoJSON polygons from Databricks),
//      colored by check-in count.
//   3. Emit the viewport bounding box (N/S/E/W) + zoom whenever the
//      user finishes panning/zooming — this is what triggers the
//      re-aggregation query upstream.
//   4. Overlay the proximity-search anchor + co-traveler markers,
//      styled distinctly from the background bins.
// ============================================================
import { useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  CircleMarker,
  Circle,
  Popup,
  useMapEvents,
} from 'react-leaflet'
import { api } from '../api.js'

// Sequential color ramp for hexbin density (low -> high).
const RAMP = ['#2c7fb8', '#41b6c4', '#7fcdbb', '#c7e9b4', '#fdae61', '#f03b20']

function colorForCount(count, max) {
  if (max <= 0) return RAMP[0]
  // Log scale — check-in counts are heavily skewed toward dense cities.
  const t = Math.log1p(count) / Math.log1p(max)
  return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]
}

// ------------------------------------------------------------
// ViewportWatcher — invisible child that subscribes to Leaflet map
// events and reports bounds + zoom. `moveend` fires once after a pan
// OR zoom settles, so this single handler covers both. The parent
// debounces before querying Databricks.
// ------------------------------------------------------------
function ViewportWatcher({ onViewportChange }) {
  const map = useMapEvents({
    moveend: () => emit(),
    zoomend: () => emit(),
  })

  function emit() {
    const b = map.getBounds()
    onViewportChange({
      north: b.getNorth(),
      south: b.getSouth(),
      east: b.getEast(),
      west: b.getWest(),
      zoom: map.getZoom(),
    })
  }

  return null
}

// Renders the venue-category breakdown inside a hexagon popup. Tracks
// three states: loading, error, and the sorted category list. When a
// cell has multiple categories we list each with its check-in count.
function HexCategories({ state }) {
  if (!state || state.loading) return <div><em>Loading venue categories…</em></div>
  if (state.error) return <div><em>Categories unavailable</em></div>
  if (!state.categories.length) return <div><em>No venue categories</em></div>

  return (
    <>
      <div style={{ fontWeight: 600, marginTop: 4 }}>
        {state.categories.length === 1
          ? 'Venue category'
          : `${state.categories.length} venue categories`}
      </div>
      <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
        {state.categories.map((c) => (
          <li key={c.category}>
            {c.category}
            {state.categories.length > 1 && (
              <span style={{ opacity: 0.7 }}> · {c.count.toLocaleString()}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

export default function Map({ bins, anchor, matches, searchRadiusKm, onViewportChange }) {
  const maxCount = useMemo(
    () => bins.reduce((m, b) => Math.max(m, b.count), 0),
    [bins],
  )

  // Latest map zoom — needed so the category query filters on the same
  // H3 resolution the bin layer was drawn at. Kept in a ref so reading
  // it at click time never lags behind a pan/zoom.
  const zoomRef = useRef(3)
  // Per-hex category breakdown, keyed by h3 string. Populated lazily on
  // click so we only hit Databricks for cells the analyst inspects.
  const [hexCats, setHexCats] = useState({})

  const handleViewportChange = (viewport) => {
    zoomRef.current = viewport.zoom
    onViewportChange(viewport)
  }

  function fetchCategories(h3) {
    // Already loaded or in flight — don't re-query on repeat clicks.
    setHexCats((prev) => {
      if (prev[h3]) return prev
      return { ...prev, [h3]: { loading: true } }
    })
    api
      .hexCategories({ h3, zoom: zoomRef.current })
      .then(({ categories }) =>
        setHexCats((prev) => ({ ...prev, [h3]: { loading: false, categories } })),
      )
      .catch(() =>
        setHexCats((prev) => ({ ...prev, [h3]: { loading: false, error: true } })),
      )
  }

  return (
    <MapContainer
      center={[20, 0]}
      zoom={3}
      className="map"
      preferCanvas
      worldCopyJump
    >
      <TileLayer
        attribution='&copy; OpenStreetMap contributors &copy; CARTO'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />

      <ViewportWatcher onViewportChange={handleViewportChange} />

      {/* H3 hexbin layer — one GeoJSON polygon per cell. Keyed by h3
          so React reuses layers across viewport updates. */}
      {bins.map((bin) => (
        <GeoJSON
          key={bin.h3}
          data={bin.boundary}
          style={{
            color: colorForCount(bin.count, maxCount),
            weight: 1,
            fillOpacity: 0.45,
          }}
          eventHandlers={{ click: () => fetchCategories(bin.h3) }}
        >
          <Popup>
            <strong>H3 {bin.h3}</strong>
            <br />
            {bin.count.toLocaleString()} check-ins
            <HexCategories state={hexCats[bin.h3]} />
          </Popup>
        </GeoJSON>
      ))}

      {/* Proximity search overlay — drawn on top of the bins. */}
      {anchor && (
        <>
          {/* Search radius ring. */}
          <Circle
            center={[anchor.lat, anchor.lon]}
            radius={searchRadiusKm * 1000}
            pathOptions={{ color: '#ffffff', weight: 1, dashArray: '4', fill: false }}
          />
          {/* Anchor checkpoint — the searched user. */}
          <CircleMarker
            center={[anchor.lat, anchor.lon]}
            radius={9}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#e7298a', fillOpacity: 1 }}
          >
            <Popup>
              <strong>Anchor — user {anchor.userId}</strong>
              <br />{anchor.venue || 'unknown venue'}
              <br />{anchor.time}
              <br />H3 {anchor.h3}
            </Popup>
          </CircleMarker>
        </>
      )}

      {/* Co-traveler matches — distinct yellow, sized nothing fancy. */}
      {matches.map((m, i) => (
        <CircleMarker
          key={`${m.userId}-${m.venueId}-${i}`}
          center={[m.lat, m.lon]}
          radius={5}
          pathOptions={{ color: '#222', weight: 1, fillColor: '#ffd92f', fillOpacity: 0.9 }}
        >
          <Popup>
            <strong>user {m.userId}</strong>
            <br />{m.venue || 'unknown venue'}
            <br />{m.time}
            <br />{m.distKm} km · {m.minutesApart} min apart
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  )
}
