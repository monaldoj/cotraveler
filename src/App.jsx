// ============================================================
// App.jsx — layout + reactive state
//
// Two reactive flows:
//   1. Viewport -> H3 bins. The map reports its bounds/zoom on every
//      pan/zoom; we debounce, then query Databricks for the
//      re-aggregated hexagons in view.
//   2. Search panel -> proximity results. Submitting the sidebar form
//      runs the spatiotemporal kRing search and overlays the anchor +
//      co-traveler markers.
// ============================================================
import { useState, useEffect, useRef, useCallback } from 'react'
import Map from './components/Map.jsx'
import SearchPanel from './components/SearchPanel.jsx'
import { api } from './api.js'

export default function App() {
  const [bins, setBins] = useState([])
  const [loadingBins, setLoadingBins] = useState(false)
  const [config, setConfig] = useState(null)

  const [anchor, setAnchor] = useState(null)
  const [matches, setMatches] = useState([])
  const [searchRadiusKm, setSearchRadiusKm] = useState(1.0)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState(null)

  // Track the latest viewport request so out-of-order responses from
  // rapid panning don't clobber the current view.
  const reqSeq = useRef(0)
  const binDebounce = useRef(null)

  useEffect(() => {
    api.config().then(setConfig).catch(() => {})
  }, [])

  // Flow 1 — viewport change -> debounced H3 bin query.
  const onViewportChange = useCallback((viewport) => {
    clearTimeout(binDebounce.current)
    binDebounce.current = setTimeout(async () => {
      const seq = ++reqSeq.current
      setLoadingBins(true)
      try {
        const { bins } = await api.h3Bins(viewport)
        if (seq === reqSeq.current) setBins(bins)
      } catch (err) {
        if (seq === reqSeq.current) setError(err.message)
      } finally {
        if (seq === reqSeq.current) setLoadingBins(false)
      }
    }, 350)
  }, [])

  // Flow 2 — proximity search.
  async function onSearch({ userId, radiusKm, windowHours }) {
    setSearching(true)
    setError(null)
    setSearchRadiusKm(radiusKm)
    try {
      const data = await api.userSearch({ userId, radiusKm, windowHours })
      if (!data.anchor) {
        setError(`No check-ins found for user ${userId}`)
        setAnchor(null)
        setMatches([])
      } else {
        setAnchor(data.anchor)
        setMatches(data.matches)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="app">
      <SearchPanel
        onSearch={onSearch}
        searching={searching}
        anchor={anchor}
        matches={matches}
        error={error}
      />
      <main className="map-wrap">
        <Map
          bins={bins}
          anchor={anchor}
          matches={matches}
          searchRadiusKm={searchRadiusKm}
          onViewportChange={onViewportChange}
        />
        <div className="status">
          {loadingBins ? 'Querying H3 bins…' : `${bins.length} hexbins in view`}
          {config && (
            <span className="conn">
              {config.connected ? ' · live' : ' · no warehouse'} · {config.table}
            </span>
          )}
        </div>
      </main>
    </div>
  )
}
