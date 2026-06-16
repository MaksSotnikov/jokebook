import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  buildLinkGraph,
  noteName,
  parseTags,
  type ApiNote,
  type PushItem,
  type PushResult,
} from '@notes/core'
import { authenticate, pull, push, UnauthorizedError } from './api'
import { buildTree, Tree } from './Tree'
import { moveJoke, parseJokes, setJokeStars, wrapJoke, type JokeSegment } from './jokes'
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

/** Render note markdown (with wiki-link and tag transforms) to HTML. */
function renderMd(text: string): string {
  return marked.parse(wikiLinksToMarkdown(tagsToMarkdown(text))) as string
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
  // On narrow screens the user can "pin" the note list so it stays docked
  // beside the open note (a two-pane layout) instead of being a separate view.
  const [pinned, setPinned] = useState(() => localStorage.getItem('notes.web.pinned') === '1')
  // Two-pane whenever the viewport is wide, or the user pinned the menu.
  const twoPane = wide || pinned
  const togglePinned = useCallback(() => {
    setPinned((p) => {
      const next = !p
      localStorage.setItem('notes.web.pinned', next ? '1' : '0')
      return next
    })
  }, [])
  const importRef = useRef<HTMLInputElement>(null)
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
  // Folder path whose folder-picker sheet is open (same sheet, folder move).
  const [movingFolder, setMovingFolder] = useState<string | null>(null)

  const cursorRef = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  // Last textarea selection, tracked so the "Mark as joke" button still works
  // when tapping it collapses the selection (common on mobile).
  const selRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
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

  /** Wrap the current editor selection as a joke block, then show the preview. */
  function markJoke() {
    const ta = editorRef.current
    if (!ta || !current) return
    let start = ta.selectionStart
    let end = ta.selectionEnd
    if (start === end) ({ start, end } = selRef.current)
    if (start === end) {
      setError('Select some text first, then mark it as a joke.')
      return
    }
    const next = wrapJoke(draft.slice(0, start), draft.slice(start, end), draft.slice(end))
    onEdit(next)
    setMode('preview')
  }

  /** Set the `index`-th joke's star rating in the current note. */
  function rateJoke(index: number, stars: number) {
    onEdit(setJokeStars(draft, index, stars))
  }

  /** Swap the `index`-th joke with its neighbour (`-1` up, `+1` down). */
  function reorderJoke(index: number, dir: -1 | 1) {
    onEdit(moveJoke(draft, index, dir))
  }

  /** Import one or more Obsidian `.md` files as notes, preserving any folder
   * structure carried in the picked paths. Existing paths are skipped so an
   * import never silently shadows a note already in the vault.
   *
   * Takes an already-snapshotted `File[]` (not the input's live `FileList`):
   * the change handler resets `input.value` right after calling us, which
   * empties the `FileList` — but the `File` objects stay readable. */
  async function importFiles(picked: File[]) {
    if (picked.length === 0) return
    const files = picked.filter((f) => f.name.toLowerCase().endsWith('.md'))
    if (files.length === 0) {
      setError('Select one or more .md files to import.')
      return
    }
    await saveNow()
    const taken = new Set(noteItems.map((n) => n.path))
    const folders = new Set<string>()
    const items: PushItem[] = []
    let skipped = 0
    for (const f of files) {
      // A directory pick exposes the path via webkitRelativePath; a plain
      // multi-file pick only gives the filename.
      const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/').replace(/^\/+/, '')
      if (taken.has(rel)) {
        skipped++
        continue
      }
      taken.add(rel)
      const content = await f.text()
      items.push({
        id: newId(),
        path: rel,
        content,
        updatedAt: Date.now(),
        deleted: false,
        baseVersion: 0,
      })
      const parts = rel.split('/')
      parts.pop()
      let acc = ''
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p
        folders.add(`${acc}/`)
      }
    }
    // Folder markers (path + `/`) so imported subfolders show in the tree.
    for (const fp of folders) {
      if (taken.has(fp)) continue
      taken.add(fp)
      items.push({
        id: newId(),
        path: fp,
        content: '',
        updatedAt: Date.now(),
        deleted: false,
        baseVersion: 0,
      })
    }
    if (items.length === 0) {
      setError(`Nothing imported — ${skipped} note${skipped === 1 ? '' : 's'} already exist.`)
      return
    }
    try {
      const { results } = await push(serverUrl, token, items)
      applyResults(results)
      const added = items.filter((i) => !i.path.endsWith('/')).length
      setError(
        `Imported ${added} note${added === 1 ? '' : 's'}` +
          (skipped ? ` (skipped ${skipped} already present)` : '') +
          '.',
      )
    } catch (e) {
      handleError(e)
    }
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

  /** Rename a note (keeps its folder); `.md` is appended if omitted. */
  async function renameNote(id: string) {
    const note = noteItems.find((n) => n.id === id)
    if (!note) return
    const slash = note.path.lastIndexOf('/')
    const dir = slash === -1 ? '' : note.path.slice(0, slash)
    const currentName = note.path.slice(slash + 1).replace(/\.md$/i, '')
    const input = window.prompt('Rename note:', currentName)?.trim()
    if (!input || input === currentName) return
    const base = /\.md$/i.test(input) ? input : `${input}.md`
    if (base.includes('/')) {
      setError('A note name cannot contain "/".')
      return
    }
    const to = dir ? `${dir}/${base}` : base
    if (noteItems.some((n) => n.id !== id && n.path === to)) {
      setError('A note with that name already exists here.')
      return
    }
    await saveNow()
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

  /** Repath a folder subtree: re-push the folder marker and every note /
   * sub-folder beneath it from `oldFolder/…` to `newFolder/…` in one batch. */
  async function repathFolder(oldFolder: string, newFolder: string) {
    const oldPrefix = `${oldFolder}/`
    const newPrefix = `${newFolder}/`
    const items: PushItem[] = notes
      .filter((n) => n.path.startsWith(oldPrefix))
      .map((n) => ({
        id: n.id,
        path: newPrefix + n.path.slice(oldPrefix.length),
        content: n.content,
        updatedAt: Date.now(),
        deleted: false,
        baseVersion: n.version,
      }))
    if (items.length === 0) return
    await saveNow()
    try {
      const { results } = await push(serverUrl, token, items)
      applyResults(results)
    } catch (e) {
      handleError(e)
    }
  }

  /** Rename a folder in place (keeps its parent). */
  async function renameFolder(folderPath: string) {
    const slash = folderPath.lastIndexOf('/')
    const parent = slash === -1 ? '' : folderPath.slice(0, slash)
    const currentName = folderPath.slice(slash + 1)
    const input = window.prompt('Rename folder:', currentName)?.trim().replace(/\/+$/, '')
    if (!input || input === currentName) return
    if (input.includes('/')) {
      setError('A folder name cannot contain "/".')
      return
    }
    const to = parent ? `${parent}/${input}` : input
    if (folderPaths.includes(to)) {
      setError('A folder with that name already exists here.')
      return
    }
    await repathFolder(folderPath, to)
  }

  /** Move a folder (and everything in it) into `toParent` (`''` = vault root). */
  async function moveFolder(folderPath: string, toParent: string) {
    const base = folderPath.split('/').pop()!
    const to = toParent ? `${toParent}/${base}` : base
    if (to === folderPath) return // already there
    if (toParent === folderPath || toParent.startsWith(`${folderPath}/`)) {
      setError("A folder can't be moved into itself.")
      return
    }
    if (folderPaths.includes(to)) {
      setError('A folder with that name already exists there.')
      return
    }
    await repathFolder(folderPath, to)
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
    () =>
      buildTree(
        noteItems.map((n) => ({ id: n.id, path: n.path })),
        folderPaths,
      ),
    [noteItems, folderPaths],
  )
  const filtering = Boolean(query.trim() || tagFilter)

  // Split the note into text / joke segments so jokes render as rated blocks.
  const segments = useMemo(() => parseJokes(draft), [draft])
  const currentTags = useMemo(() => parseTags(draft), [draft])

  // Joke tally for the end-of-note summary; average over rated jokes only.
  const jokeStats = useMemo(() => {
    const jokes = segments.filter((s): s is JokeSegment => s.type === 'joke')
    const rated = jokes.filter((j) => j.stars > 0)
    const avg = rated.length ? rated.reduce((sum, j) => sum + j.stars, 0) / rated.length : null
    return { count: jokes.length, rated: rated.length, avg }
  }, [segments])

  const sidebar = (
    <aside className="sidebar">
      <header className="sb-head">
        <div className="brand">
          <span className="brand-mark">📓</span>
          <span className="brand-name">Joke book</span>
        </div>
        <div className="sb-actions">
          <button
            className="icon"
            title="Refresh"
            disabled={syncing}
            onClick={() => void refresh()}
          >
            {syncing ? '…' : '↻'}
          </button>
          <button className="icon" title="New note" onClick={() => void newNote()}>
            ＋
          </button>
          <button className="icon" title="New folder" onClick={() => void newFolder()}>
            📁
          </button>
          <button
            className="icon"
            title="Import .md files from Obsidian"
            onClick={() => importRef.current?.click()}
          >
            📥
          </button>
          {!wide && (
            <button
              className={`icon${pinned ? ' active' : ''}`}
              title={pinned ? 'Unpin menu' : 'Pin menu'}
              onClick={togglePinned}
            >
              📌
            </button>
          )}
          <button className="icon" title="Log out" onClick={onLogout}>
            ⎋
          </button>
        </div>
      </header>
      <input
        ref={importRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        hidden
        onChange={(e) => {
          // Snapshot the files first: clearing value (so the same file can be
          // re-picked) empties the live FileList, but these File refs survive.
          const picked = e.currentTarget.files ? [...e.currentTarget.files] : []
          e.currentTarget.value = ''
          void importFiles(picked)
        }}
      />
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
          onMoveFolder={(path, parent) => void moveFolder(path, parent)}
          onMoveRequest={(id) => setMovingId(id)}
          onMoveFolderRequest={(path) => setMovingFolder(path)}
          onRenameFile={(id) => void renameNote(id)}
          onRenameFolder={(path) => void renameFolder(path)}
        />
      )}
    </aside>
  )

  const noteView = current && (
    <section className="content">
      <header className="bar">
        {!twoPane && (
          <button className="icon" title="Back" onClick={() => void back()}>
            ‹
          </button>
        )}
        <span className="bar-title" title={current.path}>
          {noteName(current.path)}
        </span>
        {!wide && (
          <button
            className={`icon${pinned ? ' active' : ''}`}
            title={pinned ? 'Unpin menu' : 'Pin menu'}
            onClick={togglePinned}
          >
            📌
          </button>
        )}
        <span className={`status ${status}`}>{status}</span>
        <button
          className="icon"
          title={mode === 'edit' ? 'Preview' : 'Edit'}
          onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
        >
          {mode === 'edit' ? '👁' : '✎'}
        </button>
        <button className="icon" title="Rename note" onClick={() => void renameNote(current.id)}>
          ✏️
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
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <button
                className="joke-btn"
                title="Wrap the selected text as a joke"
                onMouseDown={(e) => e.preventDefault()}
                onClick={markJoke}
              >
                🎤 Mark as joke
              </button>
            </div>
            <textarea
              ref={editorRef}
              className="editor"
              value={draft}
              onChange={(e) => onEdit(e.currentTarget.value)}
              onSelect={(e) =>
                (selRef.current = {
                  start: e.currentTarget.selectionStart,
                  end: e.currentTarget.selectionEnd,
                })
              }
              spellCheck={false}
              autoCapitalize="sentences"
            />
          </div>
        ) : (
          <div className="preview" onClick={onPreviewClick}>
            {segments.map((seg, i) =>
              seg.type === 'text' ? (
                <div key={i} dangerouslySetInnerHTML={{ __html: renderMd(seg.value) }} />
              ) : (
                <JokeBlock
                  key={i}
                  stars={seg.stars}
                  html={renderMd(seg.body)}
                  onRate={(n) => rateJoke(seg.index, n)}
                  canMoveUp={seg.index > 0}
                  canMoveDown={seg.index < jokeStats.count - 1}
                  onMove={(dir) => reorderJoke(seg.index, dir)}
                />
              ),
            )}
          </div>
        )}
      </div>
      {jokeStats.count > 0 && (
        <div className="joke-stats">
          <span className="joke-stats-count">
            🎤 {jokeStats.count} joke{jokeStats.count > 1 ? 's' : ''}
          </span>
          <span className="joke-stats-avg">
            {jokeStats.avg !== null ? (
              <>
                avg <span className="star on">★</span> {jokeStats.avg.toFixed(1)}
                <span className="joke-stats-dim"> ({jokeStats.rated} rated)</span>
              </>
            ) : (
              <span className="joke-stats-dim">no ratings yet</span>
            )}
          </span>
        </div>
      )}
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
    <div className={`app${wide ? ' wide' : ''}${pinned && !wide ? ' pinned' : ''}`}>
      {twoPane ? (
        <>
          {sidebar}
          {current ? noteView : welcome}
        </>
      ) : current ? (
        noteView
      ) : (
        sidebar
      )}

      {(movingId || movingFolder) && (
        <MoveSheet
          folderPaths={folderPaths}
          movingFolder={movingFolder}
          onPick={(target) => {
            if (movingFolder) void moveFolder(movingFolder, target)
            else if (movingId) void moveNote(movingId, target)
            setMovingId(null)
            setMovingFolder(null)
          }}
          onClose={() => {
            setMovingId(null)
            setMovingFolder(null)
          }}
        />
      )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error} <span className="dismiss">✕</span>
        </div>
      )}
    </div>
  )
}

// ── Move sheet ──────────────────────────────────────────────────────────

/** Touch-friendly folder picker for moving a note or a folder. When moving a
 * folder, its own subtree is excluded from the destination list. */
function MoveSheet({
  folderPaths,
  movingFolder,
  onPick,
  onClose,
}: {
  folderPaths: string[]
  movingFolder: string | null
  onPick: (target: string) => void
  onClose: () => void
}) {
  const targets = folderPaths
    .filter((f) => !movingFolder || (f !== movingFolder && !f.startsWith(`${movingFolder}/`)))
    .slice()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">Move to…</div>
        <ul className="sheet-list">
          <li onClick={() => onPick('')}>🏠 (vault root)</li>
          {targets.map((f) => (
            <li key={f} onClick={() => onPick(f)}>
              📁 {f}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ── Joke block ────────────────────────────────────────────────────────────

/** A highlighted joke with a clickable 5-star rating and up/down controls to
 * reorder it among the note's jokes. Clicking the current top star again
 * clears the rating. */
function JokeBlock({
  stars,
  html,
  onRate,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  stars: number
  html: string
  onRate: (stars: number) => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className={`joke${stars > 0 ? ' rated' : ''}`}>
      <div className="joke-rail">
        <span className="joke-badge">🎤 Joke</span>
        <div className="joke-controls">
          <div className="joke-move" role="group" aria-label="Reorder joke">
            <button
              type="button"
              className="joke-arrow"
              title="Move up"
              aria-label="Move joke up"
              disabled={!canMoveUp}
              onClick={(e) => {
                e.stopPropagation()
                onMove(-1)
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="joke-arrow"
              title="Move down"
              aria-label="Move joke down"
              disabled={!canMoveDown}
              onClick={(e) => {
                e.stopPropagation()
                onMove(1)
              }}
            >
              ↓
            </button>
          </div>
          <div className="joke-stars" role="group" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                type="button"
                className={`star${v <= stars ? ' on' : ''}`}
                title={`${v} star${v > 1 ? 's' : ''}`}
                aria-label={`${v} star${v > 1 ? 's' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onRate(v === stars ? 0 : v)
                }}
              >
                ★
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="joke-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
