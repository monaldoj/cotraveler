// ============================================================
// App.jsx — layout + reactive state
//
// Reactive flows:
//   1. Viewport -> H3 bins. The map reports its bounds/zoom on every
//      pan/zoom; we debounce, then query Databricks for the
//      re-aggregated hexagons in view.
//   2. Search a user-of-interest -> load all their check-ins. The list
//      drives both the sidebar (with selection checkboxes) and the map
//      (one marker per check-in, selected ones highlighted).
//   3. Find co-travelers -> aggregate other users proximate to the
//      selected subset (or all) of the user-of-interest's check-ins,
//      ranked by hit count.
// ============================================================
import { useState, useEffect, useRef, useCallback } from 'react'
import Map from './components/Map.jsx'
import SearchPanel from './components/SearchPanel.jsx'
import { api } from './api.js'

export default function App() {
  const [bins, setBins] = useState([])
  const [loadingBins, setLoadingBins] = useState(false)
  const [config, setConfig] = useState(null)
  const [error, setError] = useState(null)

  // Search parameters (shared by the user search and co-traveler search).
  const [radiusKm, setRadiusKm] = useState(1.0)
  const [windowHours, setWindowHours] = useState(24)

  // User-of-interest: the committed user_id, their check-ins, and which
  // check-ins (by idx) are selected as search anchors. `selected = null`
  // means "all" — the default, which lets the search anchor on the full
  // set without enumerating every idx.
  const [userOfInterest, setUserOfInterest] = useState(null)
  const [checkins, setCheckins] = useState([])
  const [loadingCheckins, setLoadingCheckins] = useState(false)
  const [selected, setSelected] = useState(null)

  // Co-traveler matches for the current user + selection.
  const [matches, setMatches] = useState(null)   // null = not yet searched
  const [searching, setSearching] = useState(false)

  // The co-traveler currently expanded on the map: their user_id and
  // full set of check-ins (each flagged isHit when proximate to an
  // anchor). Only one co-traveler is overlaid at a time.
  const [activeMatch, setActiveMatch] = useState(null)         // matchUserId | null
  const [coTravelerCheckins, setCoTravelerCheckins] = useState([])
  // Latest expanded match, so an out-of-order fetch can't overlay a
  // co-traveler the analyst has already collapsed or switched away from.
  const activeMatchRef = useRef(null)

  // Latest map viewport — shared by the H3 bins and the top-users
  // leaderboard so both reflect the same bounding box.
  const [viewport, setViewport] = useState(null)

  // Full-population H3 hexbin layer. Toggled off so the map isn't
  // overwhelmed while inspecting a specific user + co-traveler. Mirrored
  // into a ref so the stable onViewportChange callback reads the latest
  // value without being re-created on each toggle.
  const [showHexbins, setShowHexbins] = useState(true)
  const showHexbinsRef = useRef(true)

  // Track the latest viewport request so out-of-order responses from
  // rapid panning don't clobber the current view.
  const reqSeq = useRef(0)
  const binDebounce = useRef(null)

  useEffect(() => {
    api.config().then(setConfig).catch(() => {})
  }, [])

  // Fetch + apply the H3 bins for a viewport, guarded against
  // out-of-order responses. No-op (and clears the layer) when hexbins
  // are toggled off.
  const fetchBins = useCallback(async (vp) => {
    if (!showHexbinsRef.current) { setBins([]); setLoadingBins(false); return }
    const seq = ++reqSeq.current
    setLoadingBins(true)
    try {
      const { bins } = await api.h3Bins(vp)
      if (seq === reqSeq.current) setBins(bins)
    } catch (err) {
      if (seq === reqSeq.current) setError(err.message)
    } finally {
      if (seq === reqSeq.current) setLoadingBins(false)
    }
  }, [])

  // Toggle the hexbin layer. Turning it off drops the layer immediately;
  // turning it back on re-queries the current viewport.
  function onToggleHexbins() {
    setShowHexbins((on) => {
      const next = !on
      showHexbinsRef.current = next
      if (!next) { setBins([]); reqSeq.current++ }   // cancel any in-flight result
      else if (viewport) fetchBins(viewport)
      return next
    })
  }

  // Flow 1 — viewport change -> debounced H3 bin query. Also publish
  // the (debounced) viewport so the leaderboard can re-rank in step.
  const onViewportChange = useCallback((vp) => {
    clearTimeout(binDebounce.current)
    binDebounce.current = setTimeout(() => {
      setViewport(vp)
      fetchBins(vp)
    }, 350)
  }, [fetchBins])

  // Flow 2 — search a user-of-interest and load all their check-ins.
  async function onSearchUser(userId) {
    const id = String(userId).trim()
    if (!id) return
    setError(null)
    setLoadingCheckins(true)
    setUserOfInterest(id)
    setMatches(null)          // clear any prior co-traveler results
    clearActiveMatch()        // drop any co-traveler overlay
    setSelected(null)         // default: all check-ins selected
    try {
      const { checkins } = await api.userCheckins(id)
      if (!checkins.length) {
        setError(`No check-ins found for user ${id}`)
        setCheckins([])
        setUserOfInterest(null)
      } else {
        setCheckins(checkins)
      }
    } catch (err) {
      setError(err.message)
      setCheckins([])
      setUserOfInterest(null)
    } finally {
      setLoadingCheckins(false)
    }
  }

  // Clear the user-of-interest and return to the top-users leaderboard.
  function onClearUser() {
    setUserOfInterest(null)
    setCheckins([])
    setSelected(null)
    setMatches(null)
    clearActiveMatch()
    setError(null)
  }

  // Drop the co-traveler overlay (collapsed row, cleared user, etc.).
  function clearActiveMatch() {
    activeMatchRef.current = null
    setActiveMatch(null)
    setCoTravelerCheckins([])
  }

  // Toggle one check-in's selection. We materialize "all" into a real
  // Set on first toggle so deselecting works from the default state.
  function onToggleCheckin(idx) {
    setSelected((cur) => {
      const next = new Set(cur === null ? checkins.map((c) => c.idx) : cur)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      // Back to "all" → collapse to null so the search uses the default.
      if (next.size === checkins.length) return null
      return next
    })
  }

  function onSelectAll() { setSelected(null) }
  function onSelectNone() { setSelected(new Set()) }

  // Flow 3 — aggregated co-traveler search over the selected anchors.
  async function onFindCoTravelers() {
    if (!userOfInterest) return
    // null selection => search all (server uses its anchor cap).
    const idxList = selected === null ? null : Array.from(selected)
    if (idxList && idxList.length === 0) {
      setError('Select at least one check-in to search on')
      return
    }
    setError(null)
    setSearching(true)
    clearActiveMatch()        // a fresh search invalidates any overlay
    try {
      const { matches } = await api.coTravelers({
        userId: userOfInterest, radiusKm, windowHours, idxList,
      })
      setMatches(matches)
    } catch (err) {
      setError(err.message)
    } finally {
      setSearching(false)
    }
  }

  // Lazy per-match overlap detail (which check-ins a co-traveler met).
  function fetchOverlap(matchUserId) {
    const idxList = selected === null ? null : Array.from(selected)
    return api.coTravelerOverlap({
      userId: userOfInterest, matchUserId, radiusKm, windowHours, idxList,
    })
  }

  // A match row expanded/collapsed. On expand, fetch that co-traveler's
  // full check-ins and overlay them on the map (hits highlighted); on
  // collapse, or when a different row opens, drop the previous overlay.
  function onToggleMatch(matchUserId, isOpen) {
    if (!isOpen) {
      if (activeMatchRef.current === matchUserId) clearActiveMatch()
      return
    }
    activeMatchRef.current = matchUserId
    setActiveMatch(matchUserId)
    setCoTravelerCheckins([])
    const idxList = selected === null ? null : Array.from(selected)
    api
      .coTravelerCheckins({ userId: userOfInterest, matchUserId, radiusKm, windowHours, idxList })
      .then(({ checkins }) => {
        // Ignore a response for a row that's since been collapsed/swapped.
        if (activeMatchRef.current === matchUserId) setCoTravelerCheckins(checkins)
      })
      .catch(() => {})
  }

  return (
    <div className="app">
      <SearchPanel
        radiusKm={radiusKm}
        setRadiusKm={setRadiusKm}
        windowHours={windowHours}
        setWindowHours={setWindowHours}
        viewport={viewport}
        userOfInterest={userOfInterest}
        checkins={checkins}
        loadingCheckins={loadingCheckins}
        selected={selected}
        matches={matches}
        searching={searching}
        error={error}
        onSearchUser={onSearchUser}
        onClearUser={onClearUser}
        onToggleCheckin={onToggleCheckin}
        onSelectAll={onSelectAll}
        onSelectNone={onSelectNone}
        onFindCoTravelers={onFindCoTravelers}
        fetchOverlap={fetchOverlap}
        onToggleMatch={onToggleMatch}
        activeMatch={activeMatch}
        showHexbins={showHexbins}
        onToggleHexbins={onToggleHexbins}
      />
      <main className="map-wrap">
        <Map
          bins={bins}
          checkins={checkins}
          selected={selected}
          searchRadiusKm={radiusKm}
          onViewportChange={onViewportChange}
          coTravelerCheckins={coTravelerCheckins}
          coTravelerId={activeMatch}
        />
        <div className="status">
          {!showHexbins
            ? 'Hexbins hidden'
            : loadingBins ? 'Querying H3 bins…' : `${bins.length} hexbins in view`}
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
