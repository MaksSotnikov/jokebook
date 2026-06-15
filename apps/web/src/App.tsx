import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { buildLinkGraph, noteName, parseTags, type ApiNote, type PushResult } from '@notes/core'
import { authenticate, pull, push, UnauthorizedError } from './api'
import { buildTree, Tree } from './Tree'
import {
  decodeTagHref,
  decodeWikiHref,
  resolveTarget,
  tagsToMarkdown,
  targetToNewPath,
  wikiLinksToMarkdown,
} from './wikilinks'

const AUTH_KEY = 'notes.web.auth'
const SAVE_DEBOUNCE_MS = 800

interface Auth {
  serverUrl: string
  token: string
  user: { id: string; email: string }
}

type SaveStatus = 'saved' | 'saving' | 'unsaved'

/** UUID v4. Falls back to `getRandomValues` because `crypto.randomUUID` is
 * unavailable in insecure contexts (e.g. a phone hitting `http://<LAN-IP>`). */
function newId(): string {
  const c = globalThis.crypto
  if (c.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function loadAuth(): Auth | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY)
    return raw ? (JSON.parse(raw) as Auth) : null
  } catch {
    return null
  }
}

/** True on viewports wide enough for the two-pane desktop layout. */
function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 860px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 860px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

export default function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth)
  const [error, setError] = useState<string | null>(null)

  function logout() {
    localStorage.removeItem(AUTH_KEY)
    setAuth(null)
  }

  function onAuthed(a: Auth) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(a))
    setAuth(a)
  }

  if (!auth) return <Login onAuthed={onAuthed} error={error} setError={setError} />
  return <Workspace auth={auth} onLogout={logout} error={error} setError={setError} />
}

// ── Login ───────────────────────────────────────────────────────────────────

function Login({
  onAuthed,
  error,
  setError,
}: {
  onAuthed: (a: Auth) => void
  error: string | null
  setError: (e: string | null) => void
}) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('notes.web.server') ?? '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(kind: 'login' | 'register') {
    setBusy(true)
    setError(null)
    try {
      const res = await authenticate(serverUrl, kind, email.trim(), password)
      localStorage.setItem('notes.web.server', serverUrl)
      onAuthed({ serverUrl, token: res.token, user: res.user })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <h1>Joke book</h1>
      <p className="hint">Sign in to your sync account to read and edit your notes.</p>
      <label>
        Server URL
        <input
          placeholder="leave empty if opened from the server"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.currentTarget.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </label>
      <div className="login-actions">
        <button className="primary" disabled={busy} onClick={() => void submit('login')}>
          Log in
        </button>
        <button disabled={busy} onClick={() => void submit('register')}>
          Register
        </button>
      </div>
      {error && <p className="login-error">{error}</p>}
    </main>
  )
}

// ── Workspace ─────────────────────────────────────────────────────────────

function Workspace({
  auth,
  onLogout,
  error,
  setError,
}: {
  auth: Auth
  onLogout: () => void
  error: string | null
  setError: (e: string | null) => void
}) {
  const { serverUrl, token } = auth
  const wide = useWide()
  const [notes, setNotes] = useState<ApiNote[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  // Note id whose folder-picker sheet is open (touch-friendly alternative to
  // drag-and-drop); null = closed.
  const [movingId, setMovingId] = useState<string | null>(null)

  const cursorRef = useRef(0)
  const saveTimer = useRef<number | null>(null)
  // Pending unsaved edit, flushed on navigation so switching notes never drops it.
  const pending = useRef<{ id: string; path: string; text: string; baseVersion: number } | null>(
    null,
  )

  // Folders ride the sync protocol as zero-content markers whose path ends in
  // `/` (see Tree.tsx / the desktop sync adapter). Split them out so only real
  // notes feed content, links, search and the note list.
  const noteItems = useMemo(() => notes.filter((n) => !n.path.endsWith('/')), [notes])
  const folderPaths = useMemo(
    () => notes.filter((n) => n.path.endsWith('/')).map((n) => n.path.replace(/\/+$/, '')),
    [notes],
  )

  const current = useMemo(
    () => noteItems.find((n) => n.id === selectedId) ?? null,
    [noteItems, selectedId],
  )
  const paths = useMemo(() => noteItems.map((n) => n.path), [noteItems])

  const linkGraph = useMemo(
    () => buildLinkGraph(noteItems.map((n) => ({ id: n.path, path: n.path, content: n.content }))),
    [noteItems],
  )
  const backlinks = useMemo(() => {
    if (!current) return []
    return [...(linkGraph.backlinks.get(current.path) ?? [])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    )
  }, [linkGraph, current])

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        setError('Session expired — please sign in again.')
        onLogout()
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    },
    [onLogout, setError],
  )

  /** Apply server push/pull results into local state (upsert / delete). */
  const applyResults = useCallback(
    (results: PushResult[]) => {
      setNotes((prev) => {
        const map = new Map(prev.map((n) => [n.id, n]))
        for (const r of results) {
          if (r.note.deleted) map.delete(r.note.id)
          else map.set(r.note.id, r.note)
          cursorRef.current = Math.max(cursorRef.current, r.note.rev)
        }
        return [...map.values()]
      })
      const rejected = results.find((r) => r.status === 'rejected_conflict')
      if (rejected && rejected.id === selectedId) {
        setDraft(rejected.note.content)
        setError('This note changed on the server — reloaded the latest version.')
      }
    },
    [selectedId, setError],
  )

  /** Pull changes since the last cursor and merge them in. */
  const refresh = useCallback(async () => {
    setSyncing(true)
    try {
      const { changes, cursor } = await pull(serverUrl, token, cursorRef.current)
      cursorRef.current = Math.max(cursorRef.current, cursor)
      setNotes((prev) => {
        const map = new Map(prev.map((n) => [n.id, n]))
        for (const c of changes) {
          if (c.deleted) map.delete(c.id)
          else map.set(c.id, c)
        }
        return [...map.values()]
      })
    } catch (e) {
      handleError(e)
    } finally {
      setSyncing(false)
    }
  }, [serverUrl, token, handleError])

  // Initial snapshot on sign-in.
  useEffect(() => {
    cursorRef.current = 0
    void refresh()
  }, [refresh])

  /** Flush any pending edit to the server immediately. */
  const saveNow = useCallback(async () => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const p = pending.current
    if (!p) return
    pending.current = null
    setStatus('saving')
    try {
      const { results } = await push(serverUrl, token, [
        {
          id: p.id,
          path: p.path,
          content: p.text,
          updatedAt: Date.now(),
          deleted: false,
          baseVersion: p.baseVersion,
        },
      ])
      applyResults(results)
      setStatus('saved')
    } catch (e) {
      setStatus('unsaved')
      handleError(e)
    }
  }, [serverUrl, token, applyResults, handleError])

  function onEdit(text: string) {
    setDraft(text)
    if (!current) return
    setStatus('unsaved')
    pending.current = { id: current.id, path: current.path, text, baseVersion: current.version }
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS)
  }

  async function openNote(id: string) {
    await saveNow()
    const note = noteItems.find((n) => n.id === id)
    if (!note) return
    setSelectedId(id)
    setDraft(note.content)
    setStatus('saved')
    setMode('preview')
  }

  function openByPath(path: string) {
    const note = noteItems.find((n) => n.path === path)
    if (note) void openNote(note.id)
  }

  async function back() {
    await saveNow()
    setSelectedId(null)
  }

  /** Create a note on the server and open it. */
  async function createWithPath(path: string, content: string) {
    const id = newId()
    try {
      const { results } = await push(serverUrl, token, [
        { id, path, content, updatedAt: Date.now(), deleted: false, baseVersion: 0 },
      ])
      applyResults(results)
      setSelectedId(id)
      setDraft(content)
      setStatus('saved')
      setMode('edit')
    } catch (e) {
      handleError(e)
    }
  }

  async function newNote() {
    await saveNow()
    const name = window.prompt('New note name (without .md):')?.trim()
    if (!name) return
    const path = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
    await createWithPath(path, '')
  }

  /** Create an (empty) folder by pushing a zero-content marker (path + `/`). */
  async function newFolder() {
    await saveNow()
    const name = window.prompt('New folder name:')?.trim()
    if (!name) return
    const path = `${name.replace(/\/+$/, '')}/`
    try {
      const { results } = await push(serverUrl, token, [
        { id: newId(), path, content: '', updatedAt: Date.now(), deleted: false, baseVersion: 0 },
      ])
      applyResults(results)
    } catch (e) {
      handleError(e)
    }
  }

  /** Move a note into `toFolder` (`''` = vault root) by repathing it on the server. */
  async function moveNote(id: string, toFolder: string) {
    await saveNow()
    const note = noteItems.find((n) => n.id === id)
    if (!note) return
    const base = note.path.split('/').pop()!
    const to = toFolder ? `${toFolder}/${base}` : base
    if (to === note.path) return // already there
    try {
      const { results } = await push(serverUrl, token, [
        {
          id,
          path: to,
          content: note.content,
          updatedAt: Date.now(),
          deleted: false,
          baseVersion: note.version,
        },
      ])
      applyResults(results)
    } catch (e) {
      handleError(e)
    }
  }

  async function deleteCurrent() {
    if (!current) return
    if (!window.confirm(`Delete "${current.path}"? This cannot be undone.`)) return
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pending.current = null
    try {
      const { results } = await push(serverUrl, token, [
        {
          id: current.id,
          path: current.path,
          content: '',
          updatedAt: Date.now(),
          deleted: true,
          baseVersion: current.version,
        },
      ])
      applyResults(results)
      setSelectedId(null)
    } catch (e) {
      handleError(e)
    }
  }

  /** Follow a `[[wiki-link]]`: open the match or create it. */
  async function followLink(target: string) {
    await saveNow()
    const existing = resolveTarget(target, paths)
    if (existing) {
      openByPath(existing)
      return
    }
    await createWithPath(targetToNewPath(target), '')
  }

  function activateTag(tag: string) {
    setQuery('')
    setTagFilter(tag)
    setSelectedId(null)
  }

  function onPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    const tag = decodeTagHref(href)
    if (tag !== null) {
      e.preventDefault()
      void saveNow().then(() => activateTag(tag))
      return
    }
    const target = decodeWikiHref(href)
    if (target === null) return
    e.preventDefault()
    void followLink(target)
  }

  const sorted = useMemo(
    () => [...noteItems].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())),
    [noteItems],
  )

  // List shown in the sidebar: text search, tag filter, or everything.
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      return sorted.filter(
        (n) => n.path.toLowerCase().includes(q) || n.content.toLowerCase().includes(q),
      )
    }
    if (tagFilter) {
      const key = tagFilter.toLowerCase()
      return sorted.filter((n) => parseTags(n.content).some((t) => t.toLowerCase() === key))
    }
    return sorted
  }, [sorted, query, tagFilter])

  // Folder/file tree shown when not searching or tag-filtering.
  const tree = useMemo(
    () => buildTree(noteItems.map((n) => ({ id: n.id, path: n.path })), folderPaths),
    [noteItems, folderPaths],
  )
  const filtering = Boolean(query.trim() || tagFilter)

  const previewHtml = useMemo(
    () => marked.parse(wikiLinksToMarkdown(tagsToMarkdown(draft))) as string,
    [draft],
  )
  const currentTags = useMemo(() => parseTags(draft), [draft])

  const sidebar = (
    <aside className="sidebar">
      <header className="sb-head">
        <div className="brand">
          <span className="brand-mark">📓</span>
          <span className="brand-name">Joke book</span>
        </div>
        <div className="sb-actions">
          <button className="icon" title="Refresh" disabled={syncing} onClick={() => void refresh()}>
            {syncing ? '…' : '↻'}
          </button>
          <button className="icon" title="New note" onClick={() => void newNote()}>
            ＋
          </button>
          <button className="icon" title="New folder" onClick={() => void newFolder()}>
            📁
          </button>
          <button className="icon" title="Log out" onClick={onLogout}>
            ⎋
          </button>
        </div>
      </header>
      <div className="sb-user" title={auth.user.email}>
        {auth.user.email}
      </div>
      <input
        className="search"
        placeholder="Search notes…"
        value={query}
        onChange={(e) => {
          setTagFilter(null)
          setQuery(e.currentTarget.value)
        }}
      />
      {tagFilter && (
        <div className="tag-filter">
          <span className="tag-chip">#{tagFilter}</span>
          <button className="icon" title="Clear" onClick={() => setTagFilter(null)}>
            ✕
          </button>
        </div>
      )}
      {filtering ? (
        listed.length === 0 ? (
          <p className="empty">No matching notes.</p>
        ) : (
          <ul className="list">
            {listed.map((n) => (
              <li
                key={n.id}
                className={`list-row${n.id === selectedId ? ' active' : ''}`}
                onClick={() => void openNote(n.id)}
              >
                <div className="list-text">
                  <span className="list-name">{noteName(n.path)}</span>
                  <span className="list-path">{n.path}</span>
                </div>
                <button
                  className="row-move"
                  title="Move to folder"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMovingId(n.id)
                  }}
                >
                  📂
                </button>
              </li>
            ))}
          </ul>
        )
      ) : noteItems.length === 0 && folderPaths.length === 0 ? (
        <p className="empty">No notes yet. Create one with ＋.</p>
      ) : (
        <Tree
          nodes={tree}
          activeId={selectedId}
          onSelect={(id) => void openNote(id)}
          onMove={(id, folder) => void moveNote(id, folder)}
          onMoveRequest={(id) => setMovingId(id)}
        />
      )}
    </aside>
  )

  const noteView = current && (
    <section className="content">
      <header className="bar">
        {!wide && (
          <button className="icon" title="Back" onClick={() => void back()}>
            ‹
          </button>
        )}
        <span className="bar-title" title={current.path}>
          {noteName(current.path)}
        </span>
        <span className={`status ${status}`}>{status}</span>
        <button
          className="icon"
          title={mode === 'edit' ? 'Preview' : 'Edit'}
          onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
        >
          {mode === 'edit' ? '👁' : '✎'}
        </button>
        <button className="icon" title="Move to folder" onClick={() => setMovingId(current.id)}>
          📂
        </button>
        <button className="icon danger" title="Delete" onClick={() => void deleteCurrent()}>
          🗑
        </button>
      </header>
      {currentTags.length > 0 && (
        <div className="tagrow">
          {currentTags.map((tag) => (
            <button key={tag} className="tag-chip" onClick={() => activateTag(tag)}>
              #{tag}
            </button>
          ))}
        </div>
      )}
      <div className="note-body">
        {mode === 'edit' ? (
          <textarea
            className="editor"
            value={draft}
            onChange={(e) => onEdit(e.currentTarget.value)}
            spellCheck={false}
            autoCapitalize="sentences"
          />
        ) : (
          <div
            className="preview"
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
      </div>
      <footer className="backlinks">
        <span className="backlinks-head">Backlinks ({backlinks.length})</span>
        {backlinks.length === 0 ? (
          <span className="empty-inline">No notes link here yet.</span>
        ) : (
          <ul>
            {backlinks.map((path) => (
              <li key={path} onClick={() => openByPath(path)}>
                {noteName(path)}
              </li>
            ))}
          </ul>
        )}
      </footer>
    </section>
  )

  const welcome = (
    <section className="content welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">📓</div>
        <h2>Your notes, everywhere</h2>
        <p>Pick a note from the sidebar, or create a new one to get started.</p>
        <button className="welcome-btn" onClick={() => void newNote()}>
          ＋ New note
        </button>
      </div>
    </section>
  )

  return (
    <div className={`app${wide ? ' wide' : ''}`}>
      {wide ? (
        <>
          {sidebar}
          {current ? noteView : welcome}
        </>
      ) : current ? (
        noteView
      ) : (
        sidebar
      )}

      {movingId && (
        <div className="sheet-backdrop" onClick={() => setMovingId(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">Move to…</div>
            <ul className="sheet-list">
              <li
                onClick={() => {
                  void moveNote(movingId, '')
                  setMovingId(null)
                }}
              >
                🏠 (vault root)
              </li>
              {folderPaths
                .slice()
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                .map((f) => (
                  <li
                    key={f}
                    onClick={() => {
                      void moveNote(movingId, f)
                      setMovingId(null)
                    }}
                  >
                    📁 {f}
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error} <span className="dismiss">✕</span>
        </div>
      )}
    </div>
  )
}
