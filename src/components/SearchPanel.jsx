// ============================================================
// components/SearchPanel.jsx — sidebar for the proximity search
//
// Inputs: User ID (with autocomplete), Radius (km), Time Window
// (+/- hours). Submitting runs the spatiotemporal search upstream.
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'

// ------------------------------------------------------------
// UserLeaderboard — top users by check-in count, rendered on load.
// Each row expands to lazily fetch and list that user's individual
// check-ins (most recent first). Clicking the user id also seeds the
// search form above so the leaderboard doubles as a picker.
// ------------------------------------------------------------
function UserLeaderboard({ onPick }) {
  const [users, setUsers] = useState(null)   // null = loading, [] = none
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)   // userId currently open
  // Per-user check-in state, keyed by userId: { loading } | { checkins } | { error }
  const [checkins, setCheckins] = useState({})

  useEffect(() => {
    api
      .topUsers()
      .then(({ users }) => setUsers(users))
      .catch((err) => setError(err.message))
  }, [])

  function toggle(userId) {
    setExpanded((cur) => (cur === userId ? null : userId))
    // Fetch this user's check-ins once, on first expand.
    setCheckins((prev) => {
      if (prev[userId]) return prev
      api
        .userCheckins(userId)
        .then(({ checkins }) =>
          setCheckins((p) => ({ ...p, [userId]: { checkins } })),
        )
        .catch(() => setCheckins((p) => ({ ...p, [userId]: { error: true } })))
      return { ...prev, [userId]: { loading: true } }
    })
  }

  if (error) return null
  if (users === null) return <p className="muted">Loading top users…</p>
  if (!users.length) return null

  return (
    <div className="result">
      <h2>Top users by check-ins</h2>
      <ul className="leaderboard">
        {users.map((u) => {
          const isOpen = expanded === u.userId
          const detail = checkins[u.userId]
          return (
            <li key={u.userId}>
              <div className="user-row" onClick={() => toggle(u.userId)}>
                <span className={`caret ${isOpen ? 'open' : ''}`}>▶</span>
                <span className="user-id">{u.userId}</span>
                <span className="user-count">{u.checkins.toLocaleString()}</span>
                <button
                  type="button"
                  className="pick"
                  title="Use as search anchor"
                  onClick={(e) => { e.stopPropagation(); onPick(u.userId) }}
                >
                  search
                </button>
              </div>

              {isOpen && (
                <div className="checkins">
                  {!detail || detail.loading ? (
                    <p className="muted">Loading check-ins…</p>
                  ) : detail.error ? (
                    <p className="muted">Check-ins unavailable</p>
                  ) : !detail.checkins.length ? (
                    <p className="muted">No check-ins</p>
                  ) : (
                    <ul className="checkin-list">
                      {detail.checkins.map((c, i) => (
                        <li key={i}>
                          <span className="ts">{c.time}</span>
                          <br />
                          <small>{c.venue || 'unknown'} · {c.country || '—'}</small>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function SearchPanel({ onSearch, searching, anchor, matches, error }) {
  const [userId, setUserId] = useState('')
  const [radiusKm, setRadiusKm] = useState(1.0)
  const [windowHours, setWindowHours] = useState(24)
  const [suggestions, setSuggestions] = useState([])
  const debounce = useRef(null)

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

  function submit(e) {
    e.preventDefault()
    if (!userId) return
    setSuggestions([])
    onSearch({ userId: userId.trim(), radiusKm: Number(radiusKm), windowHours: Number(windowHours) })
  }

  return (
    <aside className="sidebar">
      <h1>Co-Traveler</h1>
      <p className="subtitle">H3 spatiotemporal proximity on Databricks SQL</p>

      <form onSubmit={submit}>
        <label>
          User ID
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. 1085789"
            autoComplete="off"
            list="user-suggestions"
          />
          <datalist id="user-suggestions">
            {suggestions.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.checkins} check-ins
              </option>
            ))}
          </datalist>
        </label>

        <label>
          Radius — {radiusKm} km
          <input
            type="range"
            min="0.1"
            max="25"
            step="0.1"
            value={radiusKm}
            onChange={(e) => setRadiusKm(e.target.value)}
          />
        </label>

        <label>
          Time window — ± {windowHours} h
          <input
            type="range"
            min="1"
            max="168"
            step="1"
            value={windowHours}
            onChange={(e) => setWindowHours(e.target.value)}
          />
        </label>

        <button type="submit" disabled={searching || !userId}>
          {searching ? 'Searching…' : 'Find co-travelers'}
        </button>
      </form>

      <UserLeaderboard onPick={setUserId} />

      {error && <p className="error">{error}</p>}

      {anchor && (
        <div className="result">
          <h2>Anchor</h2>
          <p>
            User <strong>{anchor.userId}</strong> · {anchor.venue || 'unknown'}
            <br />
            {anchor.time}
            <br />
            {anchor.lat.toFixed(4)}, {anchor.lon.toFixed(4)} · {anchor.country}
          </p>

          <h2>{matches.length} co-traveler record(s)</h2>
          <ul className="matches">
            {matches.slice(0, 50).map((m, i) => (
              <li key={`${m.userId}-${i}`}>
                <span className="dot" />
                user <strong>{m.userId}</strong> · {m.distKm} km · {m.minutesApart} min
                <br />
                <small>{m.venue || 'unknown'} · {m.time}</small>
              </li>
            ))}
          </ul>
          {matches.length > 50 && <p className="muted">…{matches.length - 50} more</p>}
        </div>
      )}
    </aside>
  )
}
