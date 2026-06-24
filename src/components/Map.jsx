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
//   4. Overlay the user-of-interest's check-ins (one marker each),
//      highlighting the subset selected as co-traveler search anchors,
//      and fly to them when a user is searched.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  CircleMarker,
  Popup,
  useMap,
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

// ------------------------------------------------------------
// FlyToCheckins — when a fresh set of check-ins arrives, frame them.
// A single check-in flies to a fixed zoom; multiple fit their bounds.
// Keyed on the first check-in's identity so we only move when the
// searched user actually changes, not on every selection toggle.
// ------------------------------------------------------------
function FlyToCheckins({ checkins }) {
  const map = useMap()
  const lastKey = useRef(null)

  useEffect(() => {
    if (!checkins.length) { lastKey.current = null; return }
    const key = `${checkins[0].idx}:${checkins[0].lat},${checkins[0].lon}:${checkins.length}`
    if (key === lastKey.current) return
    lastKey.current = key

    if (checkins.length === 1) {
      map.flyTo([checkins[0].lat, checkins[0].lon], 14, { duration: 0.75 })
    } else {
      const lats = checkins.map((c) => c.lat)
      const lons = checkins.map((c) => c.lon)
      map.flyToBounds(
        [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
        { padding: [40, 40], maxZoom: 15, duration: 0.75 },
      )
    }
  }, [checkins, map])

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

// Co-traveler overlay palette — orange, distinct from the user-of-
// interest's pink. Hits (proximate to an anchor) are solid; the rest
// of the co-traveler's track is dimmed and hollow.
const CT_COLOR = '#ff7f0e'

export default function Map({
  bins, checkins, selected, searchRadiusKm, onViewportChange,
  coTravelerCheckins = [], coTravelerId = null,
}) {
  const maxCount = useMemo(
    () => bins.reduce((m, b) => Math.max(m, b.count), 0),
    [bins],
  )

  // A check-in is a selected anchor when selection is "all" (null) or
  // its idx is in the explicit set.
  const isSelected = (idx) => selected === null || selected.has(idx)

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
      <FlyToCheckins checkins={checkins} />

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

      {/* User-of-interest check-ins. Selected anchors are solid pink;
          deselected ones are dimmed and hollow so the active search
          subset reads at a glance. */}
      {checkins.map((c) => {
        const sel = isSelected(c.idx)
        return (
          <CircleMarker
            key={c.idx}
            center={[c.lat, c.lon]}
            radius={sel ? 7 : 4}
            pathOptions={
              sel
                ? { color: '#fff', weight: 2, fillColor: '#e7298a', fillOpacity: 1 }
                : { color: '#e7298a', weight: 1, fillColor: '#e7298a', fillOpacity: 0.25 }
            }
          >
            <Popup>
              <strong>#{c.idx} · {c.venue || 'unknown venue'}</strong>
              <br />{c.time}
              <br />{c.country || '—'} · {sel ? 'selected' : 'not selected'}
            </Popup>
          </CircleMarker>
        )
      })}

      {/* Expanded co-traveler's check-ins (orange). "Hits" — the ones
          proximate to a search anchor — are solid; the rest of their
          track is dimmed and hollow so the overlap reads at a glance. */}
      {coTravelerCheckins.map((c) => (
        <CircleMarker
          key={`ct-${c.idx}`}
          center={[c.lat, c.lon]}
          radius={c.isHit ? 7 : 4}
          pathOptions={
            c.isHit
              ? { color: '#fff', weight: 2, fillColor: CT_COLOR, fillOpacity: 1 }
              : { color: CT_COLOR, weight: 1, fillColor: CT_COLOR, fillOpacity: 0.25 }
          }
        >
          <Popup>
            <strong>{coTravelerId} · {c.venue || 'unknown venue'}</strong>
            <br />{c.time}
            <br />{c.country || '—'} · {c.isHit ? 'hit' : 'other check-in'}
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  )
}
