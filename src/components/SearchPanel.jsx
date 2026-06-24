// ============================================================
// components/SearchPanel.jsx — sidebar
//
// Two modes:
//   • No user searched → top-users leaderboard (browse/pick a user).
//   • A user-of-interest is searched → two stacked, collapsible
//     sections: their check-ins (with selection checkboxes) and, once
//     "Find co-travelers" runs, the aggregated co-traveler matches.
//
// The check-in section collapses after a co-traveler search and the
// results expand; re-open the check-ins to change the selected subset
// and re-run the search.
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'

// ------------------------------------------------------------
// TopUsers — leaderboard shown when no user is searched on. Counts are
// scoped to the current map viewport and re-rank as you pan/zoom, the
// same way the H3 bin rollups do. Picking a row commits that user as
// the user-of-interest. A request sequence guards against out-of-order
// responses from rapid panning.
// ------------------------------------------------------------
function TopUsers({ viewport, onPick }) {
  const [users, setUsers] = useState(null)
  const [error, setError] = useState(null)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (!viewport) return   // wait for the map's first viewport report
    const seq = ++reqSeq.current
    api
      .topUsers(viewport)
      .then(({ users }) => { if (seq === reqSeq.current) setUsers(users) })
      .catch((e) => { if (seq === reqSeq.current) setError(e.message) })
  }, [viewport])

  if (error) return null
  if (users === null) return <p className="muted">Loading top users…</p>
  if (!users.length) return <p className="muted">No users in this view</p>

  return (
    <div className="result">
      <h2>Top users in view</h2>
      <ul className="leaderboard">
        {users.map((u) => (
          <li key={u.userId}>
            <div className="user-row" onClick={() => onPick(u.userId)}>
              <span className="user-id">{u.userId}</span>
              <span className="user-count">{u.checkins.toLocaleString()}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------
// CheckinList — the user-of-interest's check-ins with selection
// checkboxes. Collapsible; the header shows the live selection count.
// ------------------------------------------------------------
function CheckinList({
  checkins, loading, selected, open, onToggleOpen,
  onToggleCheckin, onSelectAll, onSelectNone,
}) {
  const total = checkins.length
  const selCount = selected === null ? total : selected.size
  const isChecked = (idx) => (selected === null ? true : selected.has(idx))

  return (
    <div className="result">
      <h2 className="collapsible" onClick={onToggleOpen}>
        <span className={`caret ${open ? 'open' : ''}`}>▶</span>
        Check-ins
        <span className="badge">
          {loading ? '…' : `${selCount} of ${total} selected`}
        </span>
      </h2>

      {open && (
        loading ? (
          <p className="muted">Loading check-ins…</p>
        ) : (
          <>
            <div className="sel-actions">
              <button type="button" onClick={onSelectAll}>All</button>
              <button type="button" onClick={onSelectNone}>None</button>
            </div>
            <ul className="checkin-list">
              {checkins.map((c) => (
                <li key={c.idx}>
                  <label className="checkin-row">
                    <input
                      type="checkbox"
                      checked={isChecked(c.idx)}
                      onChange={() => onToggleCheckin(c.idx)}
                    />
                    <span>
                      <span className="ts">{c.time}</span>
                      <br />
                      <small>{c.venue || 'unknown'} · {c.country || '—'}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </div>
  )
}

// ------------------------------------------------------------
// MatchRow — one co-traveler match. Expands to lazily load the overlap
// detail (which of the user-of-interest's check-ins they came near).
// ------------------------------------------------------------
function MatchRow({ match, fetchOverlap }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(null)   // null | {loading} | {overlaps} | {error}

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !detail) {
      setDetail({ loading: true })
      fetchOverlap(match.userId)
        .then(({ overlaps }) => setDetail({ overlaps }))
        .catch(() => setDetail({ error: true }))
    }
  }

  return (
    <li>
      <div className="user-row" onClick={toggle}>
        <span className={`caret ${open ? 'open' : ''}`}>▶</span>
        <span className="user-id">{match.userId}</span>
        <span className="user-count">{match.hits.toLocaleString()} hits · {match.stops} stops</span>
      </div>

      {open && (
        <div className="checkins">
          {!detail || detail.loading ? (
            <p className="muted">Loading overlaps…</p>
          ) : detail.error ? (
            <p className="muted">Overlaps unavailable</p>
          ) : !detail.overlaps.length ? (
            <p className="muted">No overlaps</p>
          ) : (
            <ul className="checkin-list">
              {detail.overlaps.map((o) => (
                <li key={o.idx}>
                  <span className="ts">{o.time}</span>
                  <br />
                  <small>
                    near {o.venue || 'unknown'} · {o.nearestKm} km · {o.closestMin} min
                    {o.encounters > 1 ? ` · ${o.encounters}×` : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export default function SearchPanel({
  radiusKm, setRadiusKm, windowHours, setWindowHours, viewport,
  userOfInterest, checkins, loadingCheckins, selected, matches, searching, error,
  onSearchUser, onClearUser, onToggleCheckin, onSelectAll, onSelectNone,
  onFindCoTravelers, fetchOverlap,
}) {
  const [userId, setUserId] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const debounce = useRef(null)

  // Collapse state for the two stacked sections. A completed search
  // collapses the check-ins and expands the results.
  const [checkinsOpen, setCheckinsOpen] = useState(true)
  const [matchesOpen, setMatchesOpen] = useState(true)
  useEffect(() => {
    if (matches !== null) { setCheckinsOpen(false); setMatchesOpen(true) }
  }, [matches])

  // Debounced user-id autocomplete.
  useEffect(() => {
    if (!userId || userId.length < 2) { setSuggestions([]); return }
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      try {
        const { users } = await api.users(userId)
        setSuggestions(users)
      } catch { setSuggestions([]) }
    }, 250)
    return () => clearTimeout(debounce.current)
  }, [userId])

  function submitUser(e) {
    e.preventDefault()
    if (!userId) return
    setSuggestions([])
    onSearchUser(userId)
  }

  function clear() {
    setUserId('')
    setSuggestions([])
    onClearUser()
  }

  const selCount = selected === null ? checkins.length : selected.size

  return (
    <aside className="sidebar">
      <h1>Co-Traveler</h1>
      <p className="subtitle">H3 spatiotemporal proximity on Databricks SQL</p>

      <form onSubmit={submitUser}>
        <label>
          User ID
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. 869311"
            autoComplete="off"
            list="user-suggestions"
          />
          <datalist id="user-suggestions">
            {suggestions.map((s) => (
              <option key={s.userId} value={s.userId}>{s.checkins} check-ins</option>
            ))}
          </datalist>
        </label>

        <label>
          Radius — {radiusKm} km
          <input
            type="range" min="0.1" max="25" step="0.1"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
          />
        </label>

        <label>
          Time window — ± {windowHours} h
          <input
            type="range" min="1" max="168" step="1"
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
          />
        </label>

        <button type="submit" disabled={!userId}>
          {loadingCheckins ? 'Loading…' : 'Search user'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {/* No user searched → browse the leaderboard. */}
      {!userOfInterest && !loadingCheckins && (
        <TopUsers viewport={viewport} onPick={onSearchUser} />
      )}

      {/* A user-of-interest is active → check-ins + co-traveler search. */}
      {userOfInterest && (
        <>
          <div className="uoi">
            <span>User of interest: <strong>{userOfInterest}</strong></span>
            <button type="button" className="link" onClick={clear}>clear</button>
          </div>

          <CheckinList
            checkins={checkins}
            loading={loadingCheckins}
            selected={selected}
            open={checkinsOpen}
            onToggleOpen={() => setCheckinsOpen((o) => !o)}
            onToggleCheckin={onToggleCheckin}
            onSelectAll={onSelectAll}
            onSelectNone={onSelectNone}
          />

          <button
            type="button"
            className="find-btn"
            onClick={onFindCoTravelers}
            disabled={searching || loadingCheckins || selCount === 0}
          >
            {searching
              ? 'Searching…'
              : `Find co-travelers (${selCount === checkins.length ? 'all' : selCount} check-in${selCount === 1 ? '' : 's'})`}
          </button>

          {matches !== null && (
            <div className="result">
              <h2 className="collapsible" onClick={() => setMatchesOpen((o) => !o)}>
                <span className={`caret ${matchesOpen ? 'open' : ''}`}>▶</span>
                Co-travelers
                <span className="badge">{matches.length} match{matches.length === 1 ? '' : 'es'}</span>
              </h2>
              {matchesOpen && (
                matches.length === 0 ? (
                  <p className="muted">No co-travelers for this selection</p>
                ) : (
                  <ul className="leaderboard">
                    {matches.map((m) => (
                      <MatchRow key={m.userId} match={m} fetchOverlap={fetchOverlap} />
                    ))}
                  </ul>
                )
              )}
            </div>
          )}
        </>
      )}
    </aside>
  )
}
