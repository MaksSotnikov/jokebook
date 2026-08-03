import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  addJokesToSet,
  addJokeVersion,
  appendJokes,
  buildLinkGraph,
  isLegacySet,
  isSetNote,
  jokeBlocks,
  jokeSetSeconds,
  jokeSummary,
  migrateLegacySet,
  moveJoke,
  noteName,
  parseJokes,
  parseTags,
  performedVersion,
  removeJoke,
  removeJokeVersion,
  renderJokeSet,
  replaceJoke,
  setVersionStars,
  wrapJoke,
  type ApiNote,
  type JokeSegment,
  type JokeVersion,
  type PushItem,
  type PushResult,
} from '@notes/core'
import { authenticate, pull, push, UnauthorizedError } from './api'
import { loadVault, saveVault, vaultKey, type BackupFile } from './local'
import { makeZip } from './zip'
import { buildTree, Tree } from './Tree'
import {
  IconArrowDown,
  IconArrowUp,
  IconBold,
  IconChevronDown,
  IconChevronLeft,
  IconClose,
  IconCopy,
  IconEdit,
  IconExport,
  IconEye,
  IconFolder,
  IconFolderPlus,
  IconHome,
  IconImport,
  IconImportExport,
  IconItalic,
  IconLayers,
  IconLogout,
  IconMove,
  IconNote,
  IconPin,
  IconPlus,
  IconRefresh,
  IconRename,
  IconPause,
  IconPlay,
  IconSearch,
  IconTag,
  IconTrash,
  IconUndo,
} from './icons'
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
// Editor undo: a burst of typing within this window collapses into one undo
// step (so Undo reverts a word/phrase, not a single keystroke); the stack is
// capped so a long session can't grow it without bound.
const UNDO_COALESCE_MS = 400
const UNDO_LIMIT = 100
// Bounds for the draggable sidebar width (two-pane layouts).
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 620

interface Auth {
  serverUrl: string
  token: string
  user: { id: string; email: string }
}

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'offline'

/** An in-app modal request (replaces the browser's `prompt`/`confirm`), with a
 * `resolve` that hands the answer back to the awaiting caller. */
type DialogState =
  | {
      kind: 'prompt'
      title: string
      label?: string
      placeholder?: string
      initial: string
      confirmText: string
      resolve: (value: string | null) => void
    }
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmText: string
      danger?: boolean
      resolve: (value: boolean) => void
    }

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

/** Format a duration in seconds as `M:SS` for the set timer. */
function fmtTime(seconds: number): string {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Russian noun form of «шутка» agreeing with `n` (1 шутка · 2 шутки · 5 шуток). */
function ruJokes(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'шутка'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'шутки'
  return 'шуток'
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

  /** Drag the divider between the sidebar and the content pane. The app spans
   * the full viewport in two-pane mode, so the pointer's X is the new width. */
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX))
      widthRef.current = w
      setSidebarW(w)
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem('notes.web.sidebarW', String(widthRef.current))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])
  const importRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLInputElement>(null)
  // Draggable split between sidebar and content (two-pane layouts only).
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem('notes.web.sidebarW'))
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 304
  })
  const widthRef = useRef(sidebarW)
  // Сэт dropdown (list of sets + "build a new set") open state.
  const [showSets, setShowSets] = useState(false)
  // Open when the "Add bit" picker sheet is showing (set view only).
  const [addingBit, setAddingBit] = useState(false)
  // Rehearsal (teleprompter) overlay open state — set view only.
  const [rehearsing, setRehearsing] = useState(false)
  const [notes, setNotes] = useState<ApiNote[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  // Editor undo history for the open note (draft snapshots, most-recent last).
  // Reset when the open note changes — indices only mean anything within one
  // note's editing session.
  const undoRef = useRef<string[]>([])
  const undoAtRef = useRef(0)
  const [canUndo, setCanUndo] = useState(false)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  // When true the sidebar shows the all-tags browser instead of the note tree.
  const [showTags, setShowTags] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // Note id whose folder-picker sheet is open (touch-friendly alternative to
  // drag-and-drop); null = closed.
  const [movingId, setMovingId] = useState<string | null>(null)
  // Folder path whose folder-picker sheet is open (same sheet, folder move).
  const [movingFolder, setMovingFolder] = useState<string | null>(null)
  // Joke indices (in the open note) ticked for copying to another note.
  const [pickedJokes, setPickedJokes] = useState<Set<number>>(() => new Set())
  // True while the "send jokes to another note" target picker is open.
  const [sendingJokes, setSendingJokes] = useState(false)
  // Open when the import/export menu is showing.
  const [showData, setShowData] = useState(false)
  // The open in-app dialog (styled prompt/confirm), or null when none.
  const [dialog, setDialog] = useState<DialogState | null>(null)

  // True while the browser reports a live connection; flips drive retry + UI.
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  const cursorRef = useRef(0)
  // Per-account IndexedDB key for the offline vault cache.
  const vkey = useMemo(() => vaultKey(serverUrl, auth.user.email), [serverUrl, auth.user.email])
  // Mirror of `notes` for synchronous reads inside callbacks / persistence.
  const notesRef = useRef<ApiNote[]>([])
  // Local writes not yet acknowledged by the server (the offline queue).
  const outboxRef = useRef<PushItem[]>([])
  // Guards against pushing edits before the cached vault has hydrated.
  const hydratedRef = useRef(false)
  const saveTimer = useRef<number | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  // The scroll container of the note's reading pane (preview mode).
  const noteBodyRef = useRef<HTMLDivElement>(null)
  // Scroll fraction stashed across an edit⇄preview toggle so finishing an edit
  // keeps the reader roughly where they were, instead of jumping to the top.
  const modeScrollRef = useRef<number | null>(null)
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
  const realNotes = useMemo(() => notes.filter((n) => !n.path.endsWith('/')), [notes])
  // Sets are notes whose body is a `:::set` playlist of bits; they live in the
  // Сэт dropdown, not the note tree. `noteItems` is therefore the bits/notes.
  const setItems = useMemo(() => realNotes.filter((n) => isSetNote(n.content)), [realNotes])
  const noteItems = useMemo(() => realNotes.filter((n) => !isSetNote(n.content)), [realNotes])
  const folderPaths = useMemo(
    () => notes.filter((n) => n.path.endsWith('/')).map((n) => n.path.replace(/\/+$/, '')),
    [notes],
  )

  // The open note may be a set or a regular note, so resolve against all of them.
  const current = useMemo(
    () => realNotes.find((n) => n.id === selectedId) ?? null,
    [realNotes, selectedId],
  )
  const isSet = useMemo(() => (current ? isSetNote(current.content) : false), [current])
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

  /** Write the current vault (notes + cursor + outbox) to on-device storage so
   * it survives a reload and is available offline. Best-effort. */
  const persist = useCallback(() => {
    if (!hydratedRef.current) return
    void saveVault(vkey, {
      cursor: cursorRef.current,
      notes: notesRef.current,
      outbox: outboxRef.current,
    })
  }, [vkey])

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

  /** Send the outbox to the server. Network failures leave it queued so the
   * edits survive offline and replay on reconnect. */
  const flush = useCallback(async () => {
    const batch = outboxRef.current
    if (batch.length === 0) {
      setStatus('saved')
      return
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('offline')
      return
    }
    setStatus('saving')
    try {
      const { results } = await push(serverUrl, token, batch)
      // Drop exactly the items we sent; any re-queued during the await are new
      // object refs and survive.
      const sent = new Set(batch)
      outboxRef.current = outboxRef.current.filter((i) => !sent.has(i))
      applyResults(results)
      setStatus(outboxRef.current.length ? 'unsaved' : 'saved')
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        handleError(e)
        return
      }
      // Treat any other failure as "offline": keep the queue and retry later.
      setStatus('offline')
    }
    persist()
  }, [serverUrl, token, applyResults, handleError, persist])

  /** Coalesce local writes into the outbox (latest content per id, keeping the
   * earliest observed server baseVersion), apply them optimistically to local
   * state, then try to flush. Works with or without a connection. */
  const commit = useCallback(
    async (items: PushItem[]) => {
      if (items.length === 0) return
      setNotes((prev) => {
        const map = new Map(prev.map((n) => [n.id, n]))
        for (const it of items) {
          if (it.deleted) {
            map.delete(it.id)
            continue
          }
          const existing = map.get(it.id)
          map.set(it.id, {
            id: it.id,
            path: it.path,
            content: it.content,
            version: existing?.version ?? 0,
            updatedAt: it.updatedAt,
            deleted: false,
            rev: existing?.rev ?? 0,
          })
        }
        return [...map.values()]
      })
      const queue = new Map(outboxRef.current.map((i) => [i.id, i]))
      for (const it of items) {
        const prev = queue.get(it.id)
        queue.set(it.id, prev ? { ...it, baseVersion: prev.baseVersion } : it)
      }
      outboxRef.current = [...queue.values()]
      await flush()
    },
    [flush],
  )

  /** Pull changes since the last cursor and merge them in. Offline = no-op. */
  const refresh = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
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

  // Keep the synchronous mirror + on-device cache in step with `notes`.
  useEffect(() => {
    notesRef.current = notes
    persist()
  }, [notes, persist])

  // On sign-in: hydrate the cached vault first (instant + offline-ready), then
  // replay any queued edits and pull anything new from the server.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cached = await loadVault(vkey)
      if (cancelled) return
      if (cached) {
        cursorRef.current = cached.cursor
        outboxRef.current = cached.outbox ?? []
        notesRef.current = cached.notes
        setNotes(cached.notes)
        if (outboxRef.current.length) setStatus('unsaved')
      } else {
        cursorRef.current = 0
      }
      hydratedRef.current = true
      await flush()
      await refresh()
    })()
    return () => {
      cancelled = true
    }
    // Intentionally keyed only on the account: hydrate + initial sync run once
    // per sign-in, not whenever the flush/refresh callbacks are recreated.
  }, [vkey])

  // Watch connectivity: when the device comes back online, replay + pull.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true)
      void flush().then(() => refresh())
    }
    const goOffline = () => {
      setOnline(false)
      if (outboxRef.current.length) setStatus('offline')
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [flush, refresh])

  /** Flush any pending debounced edit (and the outbox) to the server now. */
  const saveNow = useCallback(async () => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const p = pending.current
    if (p) {
      pending.current = null
      await commit([
        {
          id: p.id,
          path: p.path,
          content: p.text,
          updatedAt: Date.now(),
          deleted: false,
          baseVersion: p.baseVersion,
        },
      ])
    } else {
      await flush()
    }
  }, [commit, flush])

  /** Apply an edit to the draft and queue the debounced save. Does NOT record
   * an undo step — used by {@link onEdit} (which snapshots first) and by the
   * Undo button (which restores a past snapshot). */
  function applyEdit(text: string) {
    setDraft(text)
    if (!current) return
    setStatus('unsaved')
    pending.current = { id: current.id, path: current.path, text, baseVersion: current.version }
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS)
  }

  function onEdit(text: string) {
    if (current && text !== draft) {
      // Snapshot the pre-edit draft for Undo. Consecutive keystrokes within
      // UNDO_COALESCE_MS collapse into a single step (only the start of a burst
      // pushes), so Undo reverts a word/phrase rather than one character.
      const stack = undoRef.current
      const now = Date.now()
      if (now - undoAtRef.current > UNDO_COALESCE_MS && stack[stack.length - 1] !== draft) {
        stack.push(draft)
        if (stack.length > UNDO_LIMIT) stack.shift()
        if (!canUndo) setCanUndo(true)
      }
      undoAtRef.current = now
    }
    applyEdit(text)
  }

  /** Wrap the current editor selection in `pre`/`post` markers (e.g. `**` for
   * bold, `*` for italic). With nothing selected, inserts the markers and drops
   * the caret between them so the user can type. Falls back to the last tracked
   * selection when tapping the button collapsed it (common on mobile). */
  function wrapSelection(pre: string, post: string) {
    const ta = editorRef.current
    if (!ta || !current) return
    let start = ta.selectionStart
    let end = ta.selectionEnd
    if (start === end) {
      // Fall back to the last tracked selection (tapping the button can collapse
      // it on mobile), clamped in case it predates a shorter note.
      start = Math.min(selRef.current.start, draft.length)
      end = Math.min(selRef.current.end, draft.length)
    }
    const sel = draft.slice(start, end)
    const next = `${draft.slice(0, start)}${pre}${sel}${post}${draft.slice(end)}`
    onEdit(next)
    requestAnimationFrame(() => {
      ta.focus()
      if (sel) ta.setSelectionRange(start + pre.length, start + pre.length + sel.length)
      else {
        const caret = start + pre.length
        ta.setSelectionRange(caret, caret)
      }
    })
  }

  /** Undo the last editor change, restoring the most recent snapshot. */
  function undoEdit() {
    const stack = undoRef.current
    const prev = stack.pop()
    if (prev === undefined) return
    setCanUndo(stack.length > 0)
    undoAtRef.current = 0 // next edit starts a fresh undo burst
    // Drop the caret where the undone change was (the first char that differs
    // between the current draft and the restored text) so a mid-note Undo keeps
    // the user in place instead of scrolling to the bottom.
    const cur = draft
    let caret = 0
    const max = Math.min(cur.length, prev.length)
    while (caret < max && cur[caret] === prev[caret]) caret++
    applyEdit(prev)
    requestAnimationFrame(() => {
      const ta = editorRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  /** Flip between edit and preview, stashing the outgoing pane's scroll fraction
   * so the incoming pane lands at the same place (see the layout effect above).
   * Finishing an edit therefore stays put instead of snapping to the top. */
  function toggleMode() {
    const outgoing = mode === 'edit' ? editorRef.current : noteBodyRef.current
    if (outgoing) {
      const range = outgoing.scrollHeight - outgoing.clientHeight
      modeScrollRef.current = range > 0 ? outgoing.scrollTop / range : 0
    }
    setMode((m) => (m === 'edit' ? 'preview' : 'edit'))
  }

  /** Show a styled text-input dialog; resolves with the entered string, or
   * `null` if the user cancels. (In-app replacement for `window.prompt`.) */
  function uiPrompt(opts: {
    title: string
    label?: string
    placeholder?: string
    initial?: string
    confirmText?: string
  }): Promise<string | null> {
    return new Promise((resolve) =>
      setDialog({
        kind: 'prompt',
        title: opts.title,
        label: opts.label,
        placeholder: opts.placeholder,
        initial: opts.initial ?? '',
        confirmText: opts.confirmText ?? 'OK',
        resolve,
      }),
    )
  }

  /** Show a styled confirmation dialog; resolves true when confirmed. (In-app
   * replacement for `window.confirm`.) */
  function uiConfirm(opts: {
    title: string
    message: string
    confirmText?: string
    danger?: boolean
  }): Promise<boolean> {
    return new Promise((resolve) =>
      setDialog({
        kind: 'confirm',
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText ?? 'OK',
        danger: opts.danger,
        resolve,
      }),
    )
  }

  /** Download the whole vault as a `.zip` of `.md` files (folders preserved via
   * the paths), so notes can be backed up or moved into another editor. */
  function exportAll() {
    setShowData(false)
    const entries = realNotes.map((n) => ({ path: n.path, content: n.content }))
    if (entries.length === 0) {
      setError('No notes to export yet.')
      return
    }
    const url = URL.createObjectURL(makeZip(entries))
    const a = document.createElement('a')
    a.href = url
    a.download = 'joke-book-export.zip'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setError(`Exported ${entries.length} note${entries.length === 1 ? '' : 's'}.`)
  }

  /** Save a full vault snapshot to the device as a single `.json` backup file —
   * a self-contained copy (ids, paths, content) that {@link restoreFromDevice}
   * can read back. On a phone this lands in Downloads / local storage. */
  function backupToDevice() {
    setShowData(false)
    if (realNotes.length === 0) {
      setError('No notes to back up yet.')
      return
    }
    const backup: BackupFile = {
      kind: 'jokebook-backup',
      version: 1,
      account: auth.user.email,
      savedAt: Date.now(),
      cursor: cursorRef.current,
      notes,
      outbox: outboxRef.current,
    }
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'joke-book-backup.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setError(`Backed up ${realNotes.length} note${realNotes.length === 1 ? '' : 's'} to your device.`)
  }

  /** Restore notes from a `.json` backup picked off the device. Notes are merged
   * into the vault (matched by id) and queued for the server like any edit, so a
   * restore works offline too. Existing notes with the same id are overwritten. */
  async function restoreFromDevice(file: File) {
    setShowData(false)
    let backup: BackupFile
    try {
      backup = JSON.parse(await file.text()) as BackupFile
    } catch {
      setError('That file is not a valid Joke book backup.')
      return
    }
    if (backup.kind !== 'jokebook-backup' || !Array.isArray(backup.notes)) {
      setError('That file is not a valid Joke book backup.')
      return
    }
    const restorable = backup.notes.filter((n) => !n.deleted)
    if (restorable.length === 0) {
      setError('The backup has no notes to restore.')
      return
    }
    if (
      !(await uiConfirm({
        title: 'Restore backup',
        message: `Restore ${restorable.length} note${
          restorable.length === 1 ? '' : 's'
        } from this backup? Notes with the same name/id will be overwritten.`,
        confirmText: 'Restore',
      }))
    )
      return
    await saveNow()
    const byId = new Map(notes.map((n) => [n.id, n]))
    const items: PushItem[] = restorable.map((n) => ({
      id: n.id,
      path: n.path,
      content: n.content,
      updatedAt: Date.now(),
      deleted: false,
      baseVersion: byId.get(n.id)?.version ?? 0,
    }))
    await commit(items)
    const added = items.filter((i) => !i.path.endsWith('/')).length
    setError(`Restored ${added} note${added === 1 ? '' : 's'} from your backup.`)
  }

  /** Wrap the current editor selection as a joke block. Stays in edit mode so
   * the user can keep marking jokes; preview is only shown when they ask. */
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
    // Keep the editor focused with the caret just past the new block, ready for
    // the next selection.
    const caret = next.length - (draft.length - end)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  /** Rate version `vi` of the `index`-th joke in the current note. */
  function rateVersion(index: number, vi: number, stars: number) {
    onEdit(setVersionStars(draft, index, vi, stars))
  }

  /** Add an empty alternative version to the `index`-th joke and drop into edit
   * mode with the caret on the blank line, ready to type the new phrasing. */
  function addVersion(index: number) {
    const { text, caret } = addJokeVersion(draft, index)
    onEdit(text)
    setMode('edit')
    requestAnimationFrame(() => {
      const ta = editorRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  /** Remove version `vi` from the `index`-th joke (never its last version). */
  function removeVersion(index: number, vi: number) {
    onEdit(removeJokeVersion(draft, index, vi))
  }

  /** Swap the `index`-th joke with its neighbour (`-1` up, `+1` down). */
  function reorderJoke(index: number, dir: -1 | 1) {
    onEdit(moveJoke(draft, index, dir))
  }

  /** Tick / untick the `index`-th joke for copying to another note. */
  function toggleJokePick(index: number) {
    setPickedJokes((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /** Copy (not move) the ticked jokes into note `targetId`, appending their
   * verbatim blocks — ratings, versions and all. */
  async function sendPickedJokes(targetId: string) {
    setSendingJokes(false)
    const target = noteItems.find((n) => n.id === targetId)
    if (!target) return
    const jokeSegs = segments.filter((s): s is JokeSegment => s.type === 'joke')
    const blocks = [...pickedJokes]
      .sort((a, b) => a - b)
      .map((i) => jokeSegs[i]?.source)
      .filter((s): s is string => Boolean(s))
    if (blocks.length === 0) return
    await saveNow()
    await commit([
      {
        id: target.id,
        path: target.path,
        content: appendJokes(target.content, blocks),
        updatedAt: Date.now(),
        deleted: false,
        baseVersion: target.version,
      },
    ])
    setPickedJokes(new Set())
    setError(
      `Copied ${blocks.length} joke${blocks.length > 1 ? 's' : ''} to ${noteName(target.path)}.`,
    )
  }

  /** Import one or more text files as notes, preserving any folder structure
   * carried in the picked paths. Markdown and common plain-text formats
   * (`.md`, `.markdown`, `.txt`, …) are accepted; non-`.md` files are stored
   * with a `.md` extension so they become first-class notes. Existing paths are
   * skipped so an import never silently shadows a note already in the vault.
   *
   * Takes an already-snapshotted `File[]` (not the input's live `FileList`):
   * the change handler resets `input.value` right after calling us, which
   * empties the `FileList` — but the `File` objects stay readable. */
  async function importFiles(picked: File[]) {
    if (picked.length === 0) return
    const TEXT_RE = /\.(md|markdown|mdown|mkd|txt|text|log)$/i
    const files = picked.filter((f) => TEXT_RE.test(f.name))
    if (files.length === 0) {
      setError('Select one or more text files (.md, .txt, …) to import.')
      return
    }
    await saveNow()
    const taken = new Set(noteItems.map((n) => n.path))
    const folders = new Set<string>()
    const items: PushItem[] = []
    let skipped = 0
    for (const f of files) {
      // A directory pick exposes the path via webkitRelativePath; a plain
      // multi-file pick only gives the filename. Any non-`.md` text extension
      // is normalised to `.md` so the import lands as an ordinary note.
      const rel = (f.webkitRelativePath || f.name)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\.(markdown|mdown|mkd|txt|text|log)$/i, '.md')
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
    await commit(items)
    const added = items.filter((i) => !i.path.endsWith('/')).length
    setError(
      `Imported ${added} note${added === 1 ? '' : 's'}` +
        (skipped ? ` (skipped ${skipped} already present)` : '') +
        '.',
    )
  }

  async function openNote(id: string) {
    await saveNow()
    const note = realNotes.find((n) => n.id === id)
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

  /** Create a note (locally + queued for the server) and open it. */
  async function createWithPath(path: string, content: string) {
    const id = newId()
    await commit([{ id, path, content, updatedAt: Date.now(), deleted: false, baseVersion: 0 }])
    setSelectedId(id)
    setDraft(content)
    setMode('edit')
  }

  async function newNote() {
    await saveNow()
    const name = (
      await uiPrompt({ title: 'New note', label: 'Name (without .md)', confirmText: 'Create' })
    )?.trim()
    if (!name) return
    const path = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
    await createWithPath(path, '')
  }

  /** Create an (empty) folder by pushing a zero-content marker (path + `/`). */
  async function newFolder() {
    await saveNow()
    const name = (
      await uiPrompt({ title: 'New folder', label: 'Folder name', confirmText: 'Create' })
    )?.trim()
    if (!name) return
    const path = `${name.replace(/\/+$/, '')}/`
    await commit([
      { id: newId(), path, content: '', updatedAt: Date.now(), deleted: false, baseVersion: 0 },
    ])
  }

  /** Create a new (empty) set and open it. A set is just a note whose body is a
   * `:::set` playlist, so it reuses the ordinary create/rename/delete paths. */
  async function newSet() {
    // NB: keep the Сэт dropdown open until the very end. Closing it up front and
    // then opening the name dialog toggles `canGoBack` false→true→false across
    // the `await`s below, which used to make the Back-button trap fire a stray
    // `history.back()` — on desktop that navigated the tab out of the app to a
    // blank page. Closing last keeps `canGoBack` stable through the whole flow.
    await saveNow()
    const name = (
      await uiPrompt({ title: 'Новый сэт', label: 'Название (без .md)', confirmText: 'Создать' })
    )?.trim()
    if (!name) {
      setShowSets(false)
      return
    }
    const base = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
    if (realNotes.some((n) => n.path === base)) {
      setShowSets(false)
      setError('Заметка с таким именем уже существует.')
      return
    }
    await createWithPath(base, renderJokeSet([]))
    setShowSets(false)
  }

  /** Add every joke from note `path` to the open set as snapshots (its prose is
   * dropped). No-op with a hint when the note carries no jokes. */
  function addJokesFromNote(path: string) {
    setAddingBit(false)
    const note = noteItems.find((n) => n.path === path)
    if (!note) return
    const blocks = jokeBlocks(note.content)
    if (blocks.length === 0) {
      setError(`В заметке «${noteName(path)}» нет шуток.`)
      return
    }
    onEdit(addJokesToSet(draft, blocks))
  }

  /** Remove the `index`-th joke from the open set. */
  function removeSetJoke(index: number) {
    onEdit(removeJoke(draft, index))
  }

  /** Reorder a joke within the open set (`-1` up, `+1` down). */
  function moveSetJoke(index: number, dir: -1 | 1) {
    onEdit(moveJoke(draft, index, dir))
  }

  /** Remove every joke a note contributed from the open set at once. Blocks are
   * dropped in descending index order so earlier indices stay valid as we go. */
  function removeSetSource(indices: number[]) {
    let text = draft
    for (const i of [...indices].sort((a, b) => b - a)) text = removeJoke(text, i)
    onEdit(text)
  }

  /** Move a note into `toFolder` (`''` = vault root) by repathing it on the server. */
  async function moveNote(id: string, toFolder: string) {
    await saveNow()
    const note = realNotes.find((n) => n.id === id)
    if (!note) return
    const base = note.path.split('/').pop()!
    const to = toFolder ? `${toFolder}/${base}` : base
    if (to === note.path) return // already there
    await commit([
      {
        id,
        path: to,
        content: note.content,
        updatedAt: Date.now(),
        deleted: false,
        baseVersion: note.version,
      },
    ])
  }

  /** Rename a note (keeps its folder); `.md` is appended if omitted. */
  async function renameNote(id: string) {
    const note = realNotes.find((n) => n.id === id)
    if (!note) return
    const slash = note.path.lastIndexOf('/')
    const dir = slash === -1 ? '' : note.path.slice(0, slash)
    const currentName = note.path.slice(slash + 1).replace(/\.md$/i, '')
    const input = (
      await uiPrompt({
        title: 'Rename note',
        label: 'New name',
        initial: currentName,
        confirmText: 'Rename',
      })
    )?.trim()
    if (!input || input === currentName) return
    const base = /\.md$/i.test(input) ? input : `${input}.md`
    if (base.includes('/')) {
      setError('A note name cannot contain "/".')
      return
    }
    const to = dir ? `${dir}/${base}` : base
    if (realNotes.some((n) => n.id !== id && n.path === to)) {
      setError('A note with that name already exists here.')
      return
    }
    await saveNow()
    await commit([
      {
        id,
        path: to,
        content: note.content,
        updatedAt: Date.now(),
        deleted: false,
        baseVersion: note.version,
      },
    ])
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
    await commit(items)
  }

  /** Rename a folder in place (keeps its parent). */
  async function renameFolder(folderPath: string) {
    const slash = folderPath.lastIndexOf('/')
    const parent = slash === -1 ? '' : folderPath.slice(0, slash)
    const currentName = folderPath.slice(slash + 1)
    const input = (
      await uiPrompt({
        title: 'Rename folder',
        label: 'New name',
        initial: currentName,
        confirmText: 'Rename',
      })
    )
      ?.trim()
      .replace(/\/+$/, '')
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
    if (
      !(await uiConfirm({
        title: 'Delete note',
        message: `Delete "${current.path}"? This cannot be undone.`,
        confirmText: 'Delete',
        danger: true,
      }))
    )
      return
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pending.current = null
    await commit([
      {
        id: current.id,
        path: current.path,
        content: '',
        updatedAt: Date.now(),
        deleted: true,
        baseVersion: current.version,
      },
    ])
    setSelectedId(null)
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
    setShowTags(false)
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
    if (target !== null) {
      e.preventDefault()
      void followLink(target)
      return
    }
    // A real external link (http(s):, mailto:, …). Open it in a new tab so it
    // never navigates away from — and tears down — this single-page app.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
      e.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
    }
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

  // Every distinct tag across the vault with its note count, for the browser.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of noteItems)
      for (const t of parseTags(n.content)) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) =>
      a[0].toLowerCase().localeCompare(b[0].toLowerCase()),
    )
  }, [noteItems])

  // Split the note into text / joke segments so jokes render as rated blocks.
  const segments = useMemo(() => parseJokes(draft), [draft])
  const currentTags = useMemo(() => parseTags(draft), [draft])

  // Joke tally for the end-of-note summary. Ratings/timing use each joke's
  // best (performed) version; the average is over jokes with any rating.
  const jokeStats = useMemo(() => jokeSummary(draft), [draft])

  // Sets shown in the Сэт dropdown, alphabetical by name.
  const sortedSets = useMemo(
    () => [...setItems].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())),
    [setItems],
  )

  // The open set's snapshot jokes (only meaningful while a set is open). Each is
  // an ordinary joke block, so the note-view joke machinery drives them too.
  const setJokeSegs = useMemo(
    () =>
      isSet ? parseJokes(draft).filter((s): s is JokeSegment => s.type === 'joke') : [],
    [isSet, draft],
  )
  // Running-order tally (count + total stage time) for the set.
  const setStats = useMemo(() => (isSet ? jokeSummary(draft) : null), [isSet, draft])

  // The set's running order as ready-to-read HTML for the rehearsal prompter —
  // only the performed (best-rated) version of each joke, the one a comic would
  // actually deliver on stage.
  const rehearseJokes = useMemo(
    () => setJokeSegs.map((seg) => renderMd(performedVersion(seg.versions).body)),
    [setJokeSegs],
  )

  // Which notes the set's jokes came from, and how many each contributed —
  // shown as a header so the set reads like the old bit-list did. Jokes are
  // snapshotted verbatim, so we attribute each by matching its raw block back
  // to a note that still holds an identical one; edited/deleted-source jokes
  // fall into `unknown` (still counted in the total).
  const setSources = useMemo(() => {
    type Source = { path: string; count: number; seconds: number; indices: number[] }
    if (!isSet) return { notes: [] as Source[], unknown: 0 }
    const blockToNote = new Map<string, string>()
    for (const n of noteItems)
      for (const b of jokeBlocks(n.content)) if (!blockToNote.has(b)) blockToNote.set(b, n.path)
    const byNote = new Map<string, JokeSegment[]>()
    let unknown = 0
    for (const seg of setJokeSegs) {
      const path = blockToNote.get(seg.source)
      if (path) {
        const arr = byNote.get(path)
        if (arr) arr.push(seg)
        else byNote.set(path, [seg])
      } else unknown++
    }
    const notes: Source[] = [...byNote.entries()]
      .map(([path, segs]) => ({
        path,
        count: segs.length,
        seconds: jokeSetSeconds(segs),
        indices: segs.map((s) => s.index),
      }))
      .sort((a, b) => noteName(a.path).toLowerCase().localeCompare(noteName(b.path).toLowerCase()))
    return { notes, unknown }
  }, [isSet, noteItems, setJokeSegs])

  // The set joke (by index) currently being re-written inline, and its buffer.
  const [editingSetJoke, setEditingSetJoke] = useState<number | null>(null)
  const [setJokeDraft, setSetJokeDraft] = useState('')

  /** Begin editing a set joke's snapshot text (seeded from its raw block). */
  function startSetJokeEdit(index: number, source: string) {
    setEditingSetJoke(index)
    setSetJokeDraft(source)
  }

  /** Save the inline edit back into the set (the original note is untouched —
   * a set joke is a snapshot). */
  function saveSetJokeEdit() {
    if (editingSetJoke === null) return
    onEdit(replaceJoke(draft, editingSetJoke, setJokeDraft))
    setEditingSetJoke(null)
  }

  // Drop any joke selection when the note or mode changes — joke indices only
  // stay valid within a single note's current preview.
  useEffect(() => {
    setPickedJokes(new Set())
    setSendingJokes(false)
  }, [selectedId, mode])

  // Close the joke picker / inline set-joke editor whenever the open note
  // changes, and drop the undo history + last-selection (both are per-note).
  useEffect(() => {
    setAddingBit(false)
    setRehearsing(false)
    setEditingSetJoke(null)
    undoRef.current = []
    undoAtRef.current = 0
    setCanUndo(false)
    selRef.current = { start: 0, end: 0 }
  }, [selectedId])

  // One-shot migration: an old bit-path set gets rewritten into the snapshot
  // joke form on open (its bits' jokes pulled inline, prose dropped). After the
  // rewrite the set carries no bits, so this never fires a second time.
  useEffect(() => {
    if (!current || !isSetNote(current.content) || !isLegacySet(current.content)) return
    const resolve = (path: string) => realNotes.find((n) => n.path === path)?.content ?? null
    const migrated = migrateLegacySet(current.content, resolve)
    if (migrated !== current.content) onEdit(migrated)
  }, [current?.id, current?.content])

  // After an edit⇄preview toggle, restore the reader's place: apply the scroll
  // fraction captured on the way out to whichever pane is now showing. Runs
  // before paint, then on the next frame once the new pane has laid out.
  useLayoutEffect(() => {
    const frac = modeScrollRef.current
    if (frac === null) return
    modeScrollRef.current = null
    requestAnimationFrame(() => {
      const el = mode === 'edit' ? editorRef.current : noteBodyRef.current
      if (!el) return
      const range = el.scrollHeight - el.clientHeight
      if (range > 0) el.scrollTop = frac * range
    })
  }, [mode])

  // ── Hardware / browser Back button ───────────────────────────────────────
  // A PWA with no router exits the app on the Android Back press. Instead, trap
  // Back while there's in-app navigation to unwind (an open note, sheet, dialog,
  // dropdown or active filter) and undo ONE layer per press; only once nothing
  // is left does Back fall through and close the app.
  const backArmedRef = useRef(false) // is our history "trap" entry on the stack?
  const selfPopRef = useRef(false) // ignore the popstate from our own cleanup back()
  const goBackRef = useRef<() => boolean>(() => false)

  // Anything Back should unwind before leaving the app. Recomputed each render.
  const canGoBack =
    rehearsing ||
    dialog !== null ||
    sendingJokes ||
    addingBit ||
    editingSetJoke !== null ||
    movingId !== null ||
    movingFolder !== null ||
    showData ||
    showSets ||
    showTags ||
    tagFilter !== null ||
    (!twoPane && selectedId !== null)

  // Close the top-most (most-recently-opened) layer; one per Back press. Kept in
  // a ref so the popstate listener (registered once) always sees fresh state.
  goBackRef.current = () => {
    // The rehearsal prompter is a full-screen layer above everything, so Back
    // leaves it first.
    if (rehearsing) {
      setRehearsing(false)
      return true
    }
    if (dialog !== null) {
      if (dialog.kind === 'prompt') dialog.resolve(null)
      else dialog.resolve(false)
      setDialog(null)
      return true
    }
    if (sendingJokes) {
      setSendingJokes(false)
      return true
    }
    if (addingBit) {
      setAddingBit(false)
      return true
    }
    if (editingSetJoke !== null) {
      setEditingSetJoke(null)
      return true
    }
    if (movingId !== null || movingFolder !== null) {
      setMovingId(null)
      setMovingFolder(null)
      return true
    }
    if (showData) {
      setShowData(false)
      return true
    }
    if (showSets) {
      setShowSets(false)
      return true
    }
    if (showTags) {
      setShowTags(false)
      return true
    }
    if (tagFilter !== null) {
      setTagFilter(null)
      return true
    }
    if (!twoPane && selectedId !== null) {
      void back()
      return true
    }
    return false
  }

  // Keep exactly one trap entry on the history stack while `canGoBack` holds.
  useEffect(() => {
    if (canGoBack && !backArmedRef.current) {
      history.pushState({ jbTrap: true }, '')
      backArmedRef.current = true
    } else if (!canGoBack && backArmedRef.current) {
      // Last layer was closed via an in-app control — drop the trap (step off our
      // pushed entry) so the next Back exits the app rather than being swallowed.
      // This assumes exactly one trap is on top, which holds only while flows
      // don't toggle `canGoBack` false→true→false across `await`s: such an
      // oscillation issues an extra `history.back()` that can traverse a *real*
      // prior entry, navigating the tab clean out of the app. `newSet` is written
      // to keep `canGoBack` stable for exactly this reason — see the note there.
      backArmedRef.current = false
      selfPopRef.current = true
      history.back()
    }
  }, [canGoBack])

  useEffect(() => {
    const onPop = () => {
      if (selfPopRef.current) {
        selfPopRef.current = false // our own cleanup — not a user Back press
        return
      }
      // User pressed Back, consuming our trap entry. Undo one layer; if more
      // remain, the effect above re-arms a fresh trap.
      backArmedRef.current = false
      goBackRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const sidebar = (
    <aside className="sidebar">
      <header className="sb-head">
        <div className="brand">
          <span className="brand-mark">🎤</span>
          <span className="brand-name">Joke book</span>
          {!online && (
            <span className="offline-pill" title="Working offline — changes will sync when you reconnect">
              offline
            </span>
          )}
        </div>
        <div className="sb-actions">
          <button
            className={`icon${syncing ? ' spinning' : ''}`}
            title="Refresh"
            disabled={syncing}
            onClick={() => void refresh()}
          >
            <IconRefresh />
          </button>
          <button className="icon" title="New note" onClick={() => void newNote()}>
            <IconPlus />
          </button>
          <button className="icon" title="New folder" onClick={() => void newFolder()}>
            <IconFolderPlus />
          </button>
          <button
            className={`icon${showTags ? ' active' : ''}`}
            title="Browse tags"
            onClick={() => {
              setQuery('')
              setTagFilter(null)
              setShowTags((s) => !s)
            }}
          >
            <IconTag />
          </button>
          <button
            className="icon"
            title="Import / Export notes"
            onClick={() => setShowData(true)}
          >
            <IconImportExport />
          </button>
          {!wide && (
            <button
              className={`icon${pinned ? ' active' : ''}`}
              title={pinned ? 'Unpin menu' : 'Pin menu'}
              onClick={togglePinned}
            >
              <IconPin />
            </button>
          )}
          <button className="icon" title="Log out" onClick={onLogout}>
            <IconLogout />
          </button>
        </div>
      </header>
      <input
        ref={importRef}
        type="file"
        accept=".md,.markdown,.mdown,.mkd,.txt,.text,.log,text/markdown,text/plain"
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
      <input
        ref={restoreRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (file) void restoreFromDevice(file)
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
          setShowTags(false)
          setQuery(e.currentTarget.value)
        }}
      />
      {tagFilter && (
        <div className="tag-filter">
          <span className="tag-chip">#{tagFilter}</span>
          <button className="icon" title="Clear" onClick={() => setTagFilter(null)}>
            <IconClose />
          </button>
        </div>
      )}
      {showTags ? (
        allTags.length === 0 ? (
          <p className="empty">No tags yet. Add #tags inside a note.</p>
        ) : (
          <div className="tag-browser">
            {allTags.map(([tag, count]) => (
              <button key={tag} className="tag-chip" onClick={() => activateTag(tag)}>
                #{tag}
                <span className="tag-count">{count}</span>
              </button>
            ))}
          </div>
        )
      ) : filtering ? (
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
                  <IconMove />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : noteItems.length === 0 && folderPaths.length === 0 ? (
        <p className="empty">No notes yet. Create one with the + button.</p>
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

      {/* Сэт dropdown — pinned below the note list. */}
      <div className={`setbar${showSets ? ' open' : ''}`}>
        {showSets && (
          <div className="set-menu">
            {sortedSets.length === 0 ? (
              <p className="set-empty">Пока нет сэтов.</p>
            ) : (
              <ul>
                {sortedSets.map((s) => (
                  <li
                    key={s.id}
                    className={s.id === selectedId ? 'active' : undefined}
                    onClick={() => {
                      setShowSets(false)
                      void openNote(s.id)
                    }}
                  >
                    <IconLayers />
                    <span>{noteName(s.path)}</span>
                  </li>
                ))}
              </ul>
            )}
            <button className="set-new" onClick={() => void newSet()}>
              <IconPlus /> Собрать новый сэт
            </button>
          </div>
        )}
        <button
          className={`set-toggle${showSets ? ' active' : ''}`}
          onClick={() => setShowSets((s) => !s)}
        >
          <IconLayers />
          <span className="set-toggle-label">Сэт</span>
          {sortedSets.length > 0 && <span className="set-toggle-count">{sortedSets.length}</span>}
          <IconChevronDown />
        </button>
      </div>
    </aside>
  )

  const noteView = current && (
    <section className="content">
      <header className="bar">
        {!twoPane && (
          <button className="icon" title="Back" onClick={() => void back()}>
            <IconChevronLeft />
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
            <IconPin />
          </button>
        )}
        <span className={`status ${status}`}>{status}</span>
        <button
          className="icon"
          title={mode === 'edit' ? 'Preview' : 'Edit'}
          onClick={toggleMode}
        >
          {mode === 'edit' ? <IconEye /> : <IconEdit />}
        </button>
        <button className="icon" title="Rename note" onClick={() => void renameNote(current.id)}>
          <IconRename />
        </button>
        <button className="icon" title="Move to folder" onClick={() => setMovingId(current.id)}>
          <IconMove />
        </button>
        <button className="icon danger" title="Delete" onClick={() => void deleteCurrent()}>
          <IconTrash />
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
      <div className="note-body" ref={noteBodyRef}>
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
              <span className="editor-toolbar-sep" />
              <button
                className="fmt-btn"
                title="Bold (**text**)"
                aria-label="Bold"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => wrapSelection('**', '**')}
              >
                <IconBold />
              </button>
              <button
                className="fmt-btn"
                title="Italic (*text*)"
                aria-label="Italic"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => wrapSelection('*', '*')}
              >
                <IconItalic />
              </button>
              <button
                className="fmt-btn"
                title="Undo"
                aria-label="Undo"
                disabled={!canUndo}
                onMouseDown={(e) => e.preventDefault()}
                onClick={undoEdit}
              >
                <IconUndo />
              </button>
            </div>
            <textarea
              ref={editorRef}
              className="editor"
              value={draft}
              onChange={(e) => onEdit(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Route Ctrl/Cmd+Z through our own undo so the keyboard and the
                // Undo button share one history — otherwise the native textarea
                // undo and our stack diverge and fight. (Shift+Z = redo, which
                // we don't offer, is left to the browser.)
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
                  e.preventDefault()
                  undoEdit()
                }
              }}
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
                  versions={seg.versions}
                  render={renderMd}
                  picked={pickedJokes.has(seg.index)}
                  onTogglePick={() => toggleJokePick(seg.index)}
                  onRate={(vi, n) => rateVersion(seg.index, vi, n)}
                  onAddVersion={() => addVersion(seg.index)}
                  onRemoveVersion={(vi) => removeVersion(seg.index, vi)}
                  canMoveUp={seg.index > 0}
                  canMoveDown={seg.index < jokeStats.count - 1}
                  onMove={(dir) => reorderJoke(seg.index, dir)}
                />
              ),
            )}
          </div>
        )}
      </div>
      {mode === 'preview' && pickedJokes.size > 0 && (
        <div className="joke-pickbar">
          <span className="joke-pickbar-count">
            {pickedJokes.size} joke{pickedJokes.size > 1 ? 's' : ''} selected
          </span>
          <div className="joke-pickbar-actions">
            <button className="joke-pickbar-clear" onClick={() => setPickedJokes(new Set())}>
              Clear
            </button>
            <button className="joke-pickbar-send" onClick={() => setSendingJokes(true)}>
              <IconCopy /> Copy to note…
            </button>
          </div>
        </div>
      )}
      {jokeStats.count > 0 && (
        <div className="joke-stats">
          <span className="joke-stats-count">
            🎤 {jokeStats.count} joke{jokeStats.count > 1 ? 's' : ''}
          </span>
          <span
            className="joke-stats-time"
            title="Estimated stage time at 150 words/min (best version of each joke)"
          >
            ⏱ {fmtTime(jokeStats.seconds)}
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

  // The set view: a two-part running order — a list of bits (name · time · avg
  // rating) up top, and the composed full text of every bit below it.
  const setView = current && isSet && (
    <section className="content">
      <header className="bar">
        {!twoPane && (
          <button className="icon" title="Back" onClick={() => void back()}>
            <IconChevronLeft />
          </button>
        )}
        <span className="bar-title" title={current.path}>
          <IconLayers /> {noteName(current.path)}
        </span>
        {!wide && (
          <button
            className={`icon${pinned ? ' active' : ''}`}
            title={pinned ? 'Unpin menu' : 'Pin menu'}
            onClick={togglePinned}
          >
            <IconPin />
          </button>
        )}
        <span className={`status ${status}`}>{status}</span>
        <button
          className="icon"
          title="Переименовать сэт"
          onClick={() => void renameNote(current.id)}
        >
          <IconRename />
        </button>
        <button className="icon danger" title="Удалить сэт" onClick={() => void deleteCurrent()}>
          <IconTrash />
        </button>
      </header>

      <div className="note-body set-body">
        {setJokeSegs.length > 0 && (setSources.notes.length > 0 || setSources.unknown > 0) && (
          <div className="set-sources">
            <span className="set-sources-head">Заметки в сэте:</span>
            {setSources.notes.map((src) => (
              <span key={src.path} className="set-source-chip" title={src.path}>
                <button
                  type="button"
                  className="set-source-open"
                  title={`Открыть «${noteName(src.path)}»`}
                  onClick={() => openByPath(src.path)}
                >
                  <IconNote /> {noteName(src.path)}
                </button>
                <span className="set-source-meta" title="Шуток · хронометраж">
                  {src.count} · ⏱ {fmtTime(src.seconds)}
                </span>
                {editingSetJoke === null && (
                  <button
                    type="button"
                    className="set-source-remove"
                    title="Убрать шутки этой заметки из сэта"
                    onClick={() => removeSetSource(src.indices)}
                  >
                    <IconClose />
                  </button>
                )}
              </span>
            ))}
            {setSources.unknown > 0 && (
              <span
                className="set-source-chip other"
                title="Шутки, отредактированные в сэте или из удалённой заметки"
              >
                прочее
                <span className="set-source-count">{setSources.unknown}</span>
              </span>
            )}
          </div>
        )}
        <div className="set-toolbar">
          <button className="set-add-bit" onClick={() => setAddingBit(true)}>
            <IconPlus /> Добавить шутки
          </button>
          {setJokeSegs.length > 0 && (
            <button
              className="set-rehearse"
              title="Режим суфлёра: прогнать сэт с автопрокруткой"
              onClick={() => setRehearsing(true)}
            >
              <IconPlay /> Репетиция
            </button>
          )}
          {setJokeSegs.length > 0 && setStats && (
            <span className="set-total" title="Кол-во шуток и суммарный хронометраж лучших версий">
              🎤 {setStats.count} {ruJokes(setStats.count)} · ⏱ {fmtTime(setStats.seconds)}
            </span>
          )}
        </div>

        {setJokeSegs.length === 0 ? (
          <p className="empty">
            В сэте пока нет шуток. Нажмите «Добавить шутки», чтобы перенести шутки из заметки.
          </p>
        ) : (
          <div className="set-script preview" onClick={onPreviewClick}>
            {setJokeSegs.map((seg, i) =>
              editingSetJoke === seg.index ? (
                <div
                  key={seg.index}
                  className="set-bit-editor"
                  onClick={(e) => e.stopPropagation()}
                >
                  <textarea
                    className="editor"
                    autoFocus
                    value={setJokeDraft}
                    onChange={(e) => setSetJokeDraft(e.currentTarget.value)}
                  />
                  <div className="set-bit-editor-actions">
                    <button className="set-add-bit" onClick={saveSetJokeEdit}>
                      Сохранить
                    </button>
                    <button
                      className="icon"
                      title="Отмена"
                      onClick={() => setEditingSetJoke(null)}
                    >
                      <IconClose />
                    </button>
                  </div>
                </div>
              ) : (
                <JokeBlock
                  key={seg.index}
                  versions={seg.versions}
                  render={renderMd}
                  onRate={(vi, n) => rateVersion(seg.index, vi, n)}
                  onRemoveVersion={(vi) => removeVersion(seg.index, vi)}
                  // While one joke is being edited inline, freeze the controls
                  // that renumber jokes (reorder / remove / open another editor):
                  // editingSetJoke tracks a position, so shifting indices under
                  // it would save the buffer onto the wrong joke.
                  canMoveUp={editingSetJoke === null && i > 0}
                  canMoveDown={editingSetJoke === null && i < setJokeSegs.length - 1}
                  onMove={(dir) => moveSetJoke(seg.index, dir)}
                  onRemove={editingSetJoke === null ? () => removeSetJoke(seg.index) : undefined}
                  onEditText={
                    editingSetJoke === null
                      ? () => startSetJokeEdit(seg.index, seg.source)
                      : undefined
                  }
                />
              ),
            )}
          </div>
        )}
      </div>
    </section>
  )

  const welcome = (
    <section className="content welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">🎤</div>
        <h2>Tonight&rsquo;s material, ready when you are</h2>
        <p>Pick a set from the sidebar, or start a new one to write your next bit.</p>
        <button className="welcome-btn" onClick={() => void newNote()}>
          <IconPlus /> New note
        </button>
      </div>
    </section>
  )

  const mainPane = current ? (isSet ? setView : noteView) : welcome

  return (
    <div
      className={`app${wide ? ' wide' : ''}${pinned && !wide ? ' pinned' : ''}`}
      // The pixel sidebar width + draggable resizer are a desktop affordance;
      // on a pinned phone, fall back to the CSS percentage split so the note
      // column keeps a usable share of the narrow viewport.
      style={wide ? { gridTemplateColumns: `${sidebarW}px minmax(0, 1fr)` } : undefined}
    >
      {twoPane ? (
        <>
          {sidebar}
          {wide && (
            <div
              className="resizer"
              role="separator"
              aria-orientation="vertical"
              title="Перетащите, чтобы изменить ширину панелей"
              onMouseDown={startResize}
              style={{ left: `${sidebarW}px` }}
            />
          )}
          {mainPane}
        </>
      ) : current ? (
        isSet ? (
          setView
        ) : (
          noteView
        )
      ) : (
        sidebar
      )}

      {addingBit && current && isSet && (
        <AddBitSheet
          bits={noteItems.filter((n) => jokeBlocks(n.content).length > 0)}
          onPick={addJokesFromNote}
          onClose={() => setAddingBit(false)}
        />
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

      {sendingJokes && current && (
        <SendJokesSheet
          count={pickedJokes.size}
          notes={sorted.filter((n) => n.id !== current.id)}
          onPick={(id) => void sendPickedJokes(id)}
          onClose={() => setSendingJokes(false)}
        />
      )}

      {showData && (
        <DataSheet
          onImport={() => {
            setShowData(false)
            importRef.current?.click()
          }}
          onExport={exportAll}
          onBackup={backupToDevice}
          onRestore={() => {
            setShowData(false)
            restoreRef.current?.click()
          }}
          onClose={() => setShowData(false)}
        />
      )}

      {dialog && <Dialog state={dialog} onClose={() => setDialog(null)} />}

      {rehearsing && current && isSet && (
        <Rehearsal
          jokes={rehearseJokes}
          title={noteName(current.path)}
          onExit={() => setRehearsing(false)}
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
          <li onClick={() => onPick('')}>
            <IconHome /> (vault root)
          </li>
          {targets.map((f) => (
            <li key={f} onClick={() => onPick(f)}>
              <IconFolder /> {f}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ── Import / Export sheet ───────────────────────────────────────────────

/** The data menu opened by the import/export button: pick which to do. */
function DataSheet({
  onImport,
  onExport,
  onBackup,
  onRestore,
  onClose,
}: {
  onImport: () => void
  onExport: () => void
  onBackup: () => void
  onRestore: () => void
  onClose: () => void
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">Data &amp; backup</div>
        <ul className="sheet-list">
          <li onClick={onImport}>
            <IconImport /> Import files…
          </li>
          <li onClick={onExport}>
            <IconExport /> Export all notes (.zip)
          </li>
          <li onClick={onBackup}>
            <IconExport /> Back up to device (.json)
          </li>
          <li onClick={onRestore}>
            <IconImport /> Restore from backup…
          </li>
        </ul>
      </div>
    </div>
  )
}

// ── Dialog (styled prompt / confirm) ──────────────────────────────────────

/** App-themed modal replacing the browser's `prompt`/`confirm`. Resolves the
 * promise stored on `state` and then closes. Enter confirms, Escape cancels. */
function Dialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? state.initial : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state.kind === 'prompt') {
      const el = inputRef.current
      el?.focus()
      el?.select()
    } else {
      // Focus the dialog itself so Escape (handled below) works for confirms.
      boxRef.current?.focus()
    }
  }, [state.kind])

  function cancel() {
    if (state.kind === 'prompt') state.resolve(null)
    else state.resolve(false)
    onClose()
  }

  function confirm() {
    if (state.kind === 'prompt') state.resolve(value)
    else state.resolve(true)
    onClose()
  }

  return (
    <div className="dialog-backdrop" onClick={cancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        ref={boxRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel()
        }}
      >
        <div className="dialog-title">{state.title}</div>
        {state.kind === 'prompt' ? (
          <label className="dialog-field">
            {state.label && <span>{state.label}</span>}
            <input
              ref={inputRef}
              value={value}
              placeholder={state.placeholder}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  confirm()
                }
              }}
            />
          </label>
        ) : (
          <p className="dialog-message">{state.message}</p>
        )}
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={cancel}>
            Cancel
          </button>
          <button
            className={`dialog-confirm${state.kind === 'confirm' && state.danger ? ' danger' : ''}`}
            onClick={confirm}
          >
            {state.confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Send-jokes sheet ──────────────────────────────────────────────────────

/** Note picker for copying the selected jokes into another note. */
function SendJokesSheet({
  count,
  notes,
  onPick,
  onClose,
}: {
  count: number
  notes: ApiNote[]
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          Copy {count} joke{count > 1 ? 's' : ''} to…
        </div>
        {notes.length === 0 ? (
          <p className="empty">No other notes to copy into.</p>
        ) : (
          <ul className="sheet-list">
            {notes.map((n) => (
              <li key={n.id} onClick={() => onPick(n.id)}>
                <IconNote /> {n.path}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Set: bit picker + composed body ───────────────────────────────────────

/** Searchable picker for adding a bit (regular note) to the open set. */
function AddBitSheet({
  bits,
  onPick,
  onClose,
}: {
  bits: ApiNote[]
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const sorted = [...bits].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
  const needle = q.trim().toLowerCase()
  const matches = needle
    ? sorted.filter(
        (n) => n.path.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle),
      )
    : sorted
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">Добавить шутки из заметки</div>
        <div className="sheet-search">
          <IconSearch />
          <input
            autoFocus
            placeholder="Поиск заметки…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
        </div>
        {matches.length === 0 ? (
          <p className="empty">
            {bits.length === 0 ? 'Пока нет заметок с шутками.' : 'Ничего не найдено.'}
          </p>
        ) : (
          <ul className="sheet-list">
            {matches.map((n) => (
              <li key={n.id} onClick={() => onPick(n.path)}>
                <IconNote /> {n.path}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Joke block ────────────────────────────────────────────────────────────

/** A clickable 5-star rating. Clicking the current top star again clears it. */
function StarRating({ stars, onRate }: { stars: number; onRate: (stars: number) => void }) {
  return (
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
  )
}

/** A highlighted joke holding one or more alternative versions. Up/down arrows
 * reorder it among the note's jokes; each version carries its own star rating,
 * and an alternative can be added (➕) or removed (✕). In a set the pick and
 * add-version controls give way to inline edit (✎) and remove-from-set (✕). */
function JokeBlock({
  versions,
  render,
  picked,
  onTogglePick,
  onRate,
  onAddVersion,
  onRemoveVersion,
  canMoveUp,
  canMoveDown,
  onMove,
  onRemove,
  onEditText,
}: {
  versions: JokeVersion[]
  render: (body: string) => string
  picked?: boolean
  onTogglePick?: () => void
  onRate: (versionIndex: number, stars: number) => void
  onAddVersion?: () => void
  onRemoveVersion: (versionIndex: number) => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (dir: -1 | 1) => void
  onRemove?: () => void
  onEditText?: () => void
}) {
  const multi = versions.length > 1
  const rated = versions.some((v) => v.stars > 0)
  return (
    <div className={`joke${rated ? ' rated' : ''}${picked ? ' picked' : ''}`}>
      <div className="joke-rail">
        {onTogglePick ? (
          <label className="joke-pick" title="Select to copy to another note">
            <input
              type="checkbox"
              checked={picked}
              onClick={(e) => e.stopPropagation()}
              onChange={onTogglePick}
            />
            <span className="joke-badge">
              🎤 Joke{multi ? ` · ${versions.length} versions` : ''}
            </span>
          </label>
        ) : (
          <span className="joke-badge">🎤 Joke{multi ? ` · ${versions.length} versions` : ''}</span>
        )}
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
            <IconArrowUp />
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
            <IconArrowDown />
          </button>
          {onEditText && (
            <button
              type="button"
              className="joke-arrow"
              title="Изменить текст шутки в сэте (оригинал не меняется)"
              aria-label="Edit joke text"
              onClick={(e) => {
                e.stopPropagation()
                onEditText()
              }}
            >
              <IconEdit />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="joke-arrow"
              title="Убрать шутку из сэта"
              aria-label="Remove joke from set"
              onClick={(e) => {
                e.stopPropagation()
                onRemove()
              }}
            >
              <IconClose />
            </button>
          )}
        </div>
      </div>
      {versions.map((v, vi) => (
        <div key={vi} className={`joke-version${multi ? ' multi' : ''}`}>
          <div className="joke-version-head">
            {multi && <span className="joke-version-label">V{vi + 1}</span>}
            <StarRating stars={v.stars} onRate={(n) => onRate(vi, n)} />
            {multi && (
              <button
                type="button"
                className="joke-version-del"
                title="Remove this version"
                aria-label="Remove this version"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemoveVersion(vi)
                }}
              >
                <IconClose />
              </button>
            )}
          </div>
          {v.body.trim() ? (
            <div className="joke-body" dangerouslySetInnerHTML={{ __html: render(v.body) }} />
          ) : (
            <div className="joke-body joke-empty">Empty version — switch to edit to write it.</div>
          )}
        </div>
      ))}
      {onAddVersion && (
        <button
          type="button"
          className="joke-add-version"
          title="Add an alternative version of this joke"
          onClick={(e) => {
            e.stopPropagation()
            onAddVersion()
          }}
        >
          <IconPlus /> Add alternative version
        </button>
      )}
    </div>
  )
}

// ── Rehearsal (teleprompter) ────────────────────────────────────────────

const REHEARSE_SPEED_KEY = 'notes.web.rehearseSpeed'
const REHEARSE_SPEED_DEFAULT = 40 // px / second

/** Full-screen teleprompter for rehearsing a set: the running order in large
 * text auto-scrolls at an adjustable speed while a stopwatch counts up. The
 * scroll stops once the last joke is reached, but the clock keeps running (you
 * are still "on stage"); «Начать сначала» resets both and returns to the top.
 * `jokes` are the performed versions, pre-rendered to HTML. */
function Rehearsal({
  jokes,
  title,
  onExit,
}: {
  jokes: string[]
  title: string
  onExit: () => void
}) {
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(() => {
    const v = Number(localStorage.getItem(REHEARSE_SPEED_KEY))
    return Number.isFinite(v) && v > 0 ? v : REHEARSE_SPEED_DEFAULT
  })
  const [shownSecs, setShownSecs] = useState(0)

  const scrollerRef = useRef<HTMLDivElement>(null)
  const speedRef = useRef(speed) // read live inside the rAF loop
  const elapsedRef = useRef(0) // stopwatch, float seconds
  const shownRef = useRef(0) // last integer second pushed to state

  useEffect(() => {
    speedRef.current = speed
    localStorage.setItem(REHEARSE_SPEED_KEY, String(speed))
  }, [speed])

  // Clock + scroll from one rAF loop while playing. Scrolling is written
  // straight to the DOM node (no React re-render); only the ticking whole
  // second is pushed to state. When the scroll bottoms out we stop advancing it
  // but keep the clock running — per the rehearsal brief.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (ts: number) => {
      const dt = (ts - last) / 1000
      last = ts
      elapsedRef.current += dt
      const s = Math.floor(elapsedRef.current)
      if (s !== shownRef.current) {
        shownRef.current = s
        setShownSecs(s)
      }
      const el = scrollerRef.current
      if (el) {
        // Advance by a fractional pixel each frame (sub-pixel scrollTop keeps it
        // smooth); reading the live scrollTop also lets a manual nudge coexist.
        // Once we reach the last joke we stop moving — but the clock above keeps
        // ticking, since the comic is still "on stage".
        const max = el.scrollHeight - el.clientHeight
        if (el.scrollTop < max - 0.5) {
          el.scrollTop = Math.min(max, el.scrollTop + dt * speedRef.current)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // Desktop hotkeys: Space toggles play/pause, Esc leaves rehearsal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying((p) => !p)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onExit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

  function restart() {
    elapsedRef.current = 0
    shownRef.current = 0
    setShownSecs(0)
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
    setPlaying(true)
  }

  return (
    <div className="rehearse">
      <header className="rehearse-bar">
        <span className="rehearse-title" title={title}>
          🎤 {title}
        </span>
        <span className="rehearse-clock" title="Секундомер">
          {fmtTime(shownSecs)}
        </span>
        <label className="rehearse-speed" title="Скорость прокрутки">
          <span className="rehearse-speed-label">Скорость</span>
          <input
            type="range"
            min={10}
            max={150}
            step={5}
            value={speed}
            aria-label="Скорость прокрутки"
            onChange={(e) => setSpeed(Number(e.currentTarget.value))}
          />
        </label>
        <button
          type="button"
          className="rehearse-btn"
          onClick={() => setPlaying((p) => !p)}
          title={playing ? 'Пауза (пробел)' : 'Продолжить (пробел)'}
        >
          {playing ? <IconPause /> : <IconPlay />}
          <span>{playing ? 'Пауза' : 'Играть'}</span>
        </button>
        <button type="button" className="rehearse-btn" onClick={restart} title="Начать сначала">
          <IconRefresh />
          <span>Сначала</span>
        </button>
        <button
          type="button"
          className="rehearse-btn exit"
          onClick={onExit}
          title="Выйти из репетиции (Esc)"
        >
          <IconClose />
          <span>Выйти</span>
        </button>
      </header>
      <div className="rehearse-scroller" ref={scrollerRef}>
        <div className="rehearse-script preview">
          {jokes.map((html, i) => (
            <div key={i} className="rehearse-joke" dangerouslySetInnerHTML={{ __html: html }} />
          ))}
          <div className="rehearse-end">— конец сэта —</div>
        </div>
      </div>
    </div>
  )
}
