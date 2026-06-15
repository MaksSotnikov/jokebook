import { useCallback, useEffect, useRef, useState } from 'react'
import { runSync } from '@notes/core'
import {
  authenticate,
  loadSyncState,
  makeHttpTransport,
  makeTauriFs,
  saveSyncState,
} from '../lib/sync'

const SERVER_KEY = 'notes.sync.server'
const TOKEN_KEY = 'notes.sync.token'
const EMAIL_KEY = 'notes.sync.email'
const AUTO_KEY = 'notes.sync.auto'
const DEFAULT_SERVER = 'http://localhost:3001'

/** Pull remote changes on this cadence even when nothing local changed. */
const AUTO_INTERVAL_MS = 30_000
/** Quiet period after the last edit before an auto-sync fires. */
const EDIT_SYNC_DEBOUNCE_MS = 3_000

interface SyncPanelProps {
  vault: string
  /** Called after a successful sync so the app can reload notes from disk. */
  onSynced: () => void
  /** Increments whenever a local note is written/created/deleted. Drives
   * debounced auto-sync. Starts at 0, which is skipped (nothing changed yet). */
  editSignal: number
}

/** Login / register, manual "Sync now", and auto-sync, shown in the sidebar. */
export function SyncPanel({ vault, onSynced, editSignal }: SyncPanelProps) {
  const [server, setServer] = useState(() => localStorage.getItem(SERVER_KEY) ?? DEFAULT_SERVER)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [auto, setAuto] = useState(() => localStorage.getItem(AUTO_KEY) !== 'off')

  // Guards against overlapping syncs: if a sync is requested while one is
  // running, we remember it and run once more when the current one finishes.
  const runningRef = useRef(false)
  const rerunRef = useRef(false)

  async function doAuth(kind: 'login' | 'register') {
    setBusy(true)
    setMessage(null)
    try {
      const res = await authenticate(server, kind, email, password)
      localStorage.setItem(SERVER_KEY, server)
      localStorage.setItem(TOKEN_KEY, res.token)
      localStorage.setItem(EMAIL_KEY, res.user.email)
      setToken(res.token)
      setEmail(res.user.email)
      setPassword('')
      setMessage('Signed in.')
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setMessage(null)
  }

  const sync = useCallback(async () => {
    if (!token) return
    if (runningRef.current) {
      rerunRef.current = true // coalesce: run again once the current pass ends
      return
    }
    runningRef.current = true
    setBusy(true)
    setMessage('Syncing…')
    try {
      const state = await loadSyncState(vault)
      const { state: next, summary } = await runSync(
        makeTauriFs(vault),
        makeHttpTransport(server, token),
        state,
      )
      await saveSyncState(vault, next)
      onSynced()
      setMessage(`↑${summary.pushed} ↓${summary.pulled} ⚠${summary.conflicts}`)
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e)
      setMessage(msg)
      if (msg.includes('401')) logout() // token expired/invalid
    } finally {
      setBusy(false)
      runningRef.current = false
      if (rerunRef.current) {
        rerunRef.current = false
        void syncRef.current()
      }
    }
  }, [token, server, vault, onSynced])

  // Hold the latest `sync` so timers/triggers always call the current closure.
  const syncRef = useRef(sync)
  useEffect(() => {
    syncRef.current = sync
  })

  // Trigger 1: sync once on sign-in, on vault change, and when auto is enabled.
  useEffect(() => {
    if (token && auto) void syncRef.current()
  }, [token, vault, auto])

  // Trigger 2: periodic pull so remote edits arrive without local activity.
  useEffect(() => {
    if (!token || !auto) return
    const id = window.setInterval(() => void syncRef.current(), AUTO_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [token, auto])

  // Trigger 3: debounced sync after local edits settle.
  useEffect(() => {
    if (!token || !auto || editSignal === 0) return
    const id = window.setTimeout(() => void syncRef.current(), EDIT_SYNC_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [editSignal, token, auto])

  function toggleAuto() {
    setAuto((prev) => {
      const next = !prev
      localStorage.setItem(AUTO_KEY, next ? 'on' : 'off')
      return next
    })
  }

  return (
    <div className="sync">
      {token ? (
        <>
          <div className="sync-row">
            <button className="primary" disabled={busy} onClick={() => void sync()}>
              Sync now
            </button>
            <button disabled={busy} onClick={logout} title="Sign out">
              ⎋
            </button>
          </div>
          <label className="sync-auto" title="Sync automatically on edits, on a timer, and at startup">
            <input type="checkbox" checked={auto} onChange={toggleAuto} />
            Auto-sync
          </label>
          <div className="sync-meta" title={email}>
            {email}
          </div>
        </>
      ) : (
        <>
          <input
            className="sync-input"
            placeholder="Server URL"
            value={server}
            onChange={(e) => setServer(e.currentTarget.value)}
          />
          <input
            className="sync-input"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <input
            className="sync-input"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <div className="sync-row">
            <button className="primary" disabled={busy} onClick={() => void doAuth('login')}>
              Log in
            </button>
            <button disabled={busy} onClick={() => void doAuth('register')}>
              Register
            </button>
          </div>
        </>
      )}
      {message && <div className="sync-msg">{message}</div>}
    </div>
  )
}
