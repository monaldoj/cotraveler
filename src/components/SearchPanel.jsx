// ============================================================
// components/SearchPanel.jsx — sidebar for the proximity search
//
// Inputs: User ID (with autocomplete), Radius (km), Time Window
// (+/- hours). Submitting runs the spatiotemporal search upstream.
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'

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
