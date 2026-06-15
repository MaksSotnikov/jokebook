import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { buildLinkGraph, noteName, parseTags } from '@notes/core'
import {
  createFolder,
  createNote,
  deleteNote,
  indexVault,
  listFolders,
  onVaultChanged,
  pickVault,
  readAllNotes,
  readNote,
  renameNote,
  searchNotes,
  watchVault,
  writeNote,
  type NoteContent,
  type SearchHit,
} from './lib/api'
import { buildTree } from './lib/tree'
import {
  decodeTagHref,
  decodeWikiHref,
  resolveTarget,
  tagsToMarkdown,
  targetToNewPath,
  wikiLinksToMarkdown,
} from './lib/wikilinks'
import { Editor } from './components/Editor'
import { FileTree } from './components/FileTree'
import { GraphView } from './components/GraphView'
import { SyncPanel } from './components/SyncPanel'
import './App.css'

const VAULT_KEY = 'notes.vault'
const SAVE_DEBOUNCE_MS = 600

type SaveStatus = 'saved' | 'saving' | 'unsaved'

// SQLite wraps FTS matches in these control chars (Rust `char(2)`/`char(3)`);
// chosen because they never occur in note text.
const MARK_START = String.fromCharCode(2)
const MARK_END = String.fromCharCode(3)

/** Render an FTS snippet to safe HTML: escape the note text first, then turn
 * the match markers into `<mark>` so note content can't inject markup. */
function renderSnippet(snippet: string): string {
  return snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(MARK_START)
    .join('<mark>')
    .split(MARK_END)
    .join('</mark>')
}

function App() {
  const [vault, setVault] = useState<string | null>(() => localStorage.getItem(VAULT_KEY))
  const [index, setIndex] = useState<NoteContent[]>([])
  // Explicit folder list (incl. empty ones), so the tree shows folders that
  // hold no notes yet and can serve as drag-and-drop targets.
  const [folders, setFolders] = useState<string[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Bumped after every local write so the sync panel can debounce an auto-sync.
  const [editTick, setEditTick] = useState(0)
  const [showGraph, setShowGraph] = useState(false)

  const saveTimer = useRef<number | null>(null)
  const bumpDirty = useCallback(() => setEditTick((t) => t + 1), [])

  // The in-memory index is the single source of truth for the note list,
  // the link graph and search. `notes` (for the tree) is derived from it.
  const notes = useMemo(
    () =>
      index
        .map((n) => ({ path: n.path, name: noteName(n.path) }))
        .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())),
    [index],
  )
  const tree = useMemo(() => buildTree(notes, folders), [notes, folders])
  const noteNames = useMemo(() => notes.map((n) => n.name), [notes])
  const allPaths = useMemo(() => index.map((n) => n.path), [index])

  const linkGraph = useMemo(
    () => buildLinkGraph(index.map((n) => ({ id: n.path, path: n.path, content: n.content }))),
    [index],
  )
  const backlinks = useMemo(() => {
    if (!activePath) return []
    return [...(linkGraph.backlinks.get(activePath) ?? [])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    )
  }, [linkGraph, activePath])

  // Full-text search runs in SQLite (Rust). Debounced; `null` means "not
  // searching" so the file tree shows instead. Results can lag a fresh edit
  // by one reindex cycle, which the watch-driven loadIndex closes.
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSearchResults(null)
      return
    }
    let cancelled = false
    const id = window.setTimeout(() => {
      searchNotes(q)
        .then((hits) => {
          if (!cancelled) setSearchResults(hits)
        })
        .catch((e) => {
          if (!cancelled) setError(String(e))
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [query])

  // Tag filter: when set, the sidebar lists notes carrying that tag. Mutually
  // exclusive with text search (each clears the other when activated).
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const tagResults = useMemo(() => {
    if (!tagFilter) return null
    const key = tagFilter.toLowerCase()
    return index
      .filter((n) => parseTags(n.content).some((t) => t.toLowerCase() === key))
      .map((n) => n.path)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  }, [index, tagFilter])

  // Tags of the open note, shown as clickable chips in the editor header.
  const currentTags = useMemo(() => parseTags(content), [content])

  function activateTag(tag: string) {
    setQuery('')
    setTagFilter(tag)
  }

  const loadIndex = useCallback(async (v: string) => {
    try {
      const [notes, dirs] = await Promise.all([readAllNotes(v), listFolders(v)])
      setIndex(notes)
      setFolders(dirs)
      await indexVault(v) // keep the FTS index in lockstep with disk
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    if (vault) void loadIndex(vault)
  }, [vault, loadIndex])

  // Watch the vault on disk so sync writes / external editors refresh the
  // index live. Reads (loadIndex) only touch the note list/links/search —
  // never the open editor's text — so an incoming change can't clobber typing.
  useEffect(() => {
    if (!vault) return
    void watchVault(vault)
    let unlisten: (() => void) | undefined
    let timer: number | undefined
    void onVaultChanged(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = window.setTimeout(() => void loadIndex(vault), 400) // coalesce bursts
    }).then((u) => {
      unlisten = u
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unlisten?.()
    }
  }, [vault, loadIndex])

  /** Upsert a note's content in the in-memory index. */
  function setNoteContent(path: string, text: string) {
    setIndex((prev) => {
      const entry = { path, content: text, modified: Date.now() }
      const i = prev.findIndex((n) => n.path === path)
      if (i === -1) return [...prev, entry]
      const next = prev.slice()
      next[i] = entry
      return next
    })
  }

  function flushSave() {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
  }

  async function chooseVault() {
    const picked = await pickVault()
    if (!picked) return
    localStorage.setItem(VAULT_KEY, picked)
    setActivePath(null)
    setContent('')
    setQuery('')
    setVault(picked)
  }

  async function openNote(path: string) {
    if (!vault) return
    flushSave()
    try {
      const text = await readNote(vault, path)
      setActivePath(path)
      setContent(text)
      setStatus('saved')
      setNoteContent(path, text) // keep index fresh if changed on disk
    } catch (e) {
      setError(String(e))
    }
  }

  function onEdit(next: string) {
    setContent(next)
    if (!vault || !activePath) return
    setStatus('unsaved')
    flushSave()
    const path = activePath
    saveTimer.current = window.setTimeout(async () => {
      setStatus('saving')
      try {
        await writeNote(vault, path, next)
        setNoteContent(path, next) // refresh links/search after save
        setStatus('saved')
        bumpDirty()
      } catch (e) {
        setError(String(e))
        setStatus('unsaved')
      }
    }, SAVE_DEBOUNCE_MS)
  }

  async function newNote() {
    if (!vault) return
    const name = window.prompt('New note name (without .md):')?.trim()
    if (!name) return
    const path = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
    try {
      await createNote(vault, path)
      setNoteContent(path, '')
      bumpDirty()
      await openNote(path)
    } catch (e) {
      setError(String(e))
    }
  }

  async function newFolder() {
    if (!vault) return
    const name = window.prompt('New folder name:')?.trim()
    if (!name) return
    try {
      await createFolder(vault, name)
      await loadIndex(vault) // surfaces the new (empty) folder + any parents
    } catch (e) {
      setError(String(e))
    }
  }

  /** Move a note into `toFolder` (`''` = vault root) via a rename on disk. */
  async function moveNote(from: string, toFolder: string) {
    if (!vault) return
    const base = from.split('/').pop()!
    const to = toFolder ? `${toFolder}/${base}` : base
    if (to === from) return // already in that folder
    // Cancel any pending save: its closure targets the old path and would
    // otherwise recreate the file we just renamed away.
    flushSave()
    try {
      await renameNote(vault, from, to)
      setIndex((prev) => prev.map((n) => (n.path === from ? { ...n, path: to } : n)))
      if (activePath === from) setActivePath(to)
      bumpDirty()
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeActive() {
    if (!vault || !activePath) return
    if (!window.confirm(`Delete "${activePath}"? This cannot be undone.`)) return
    const path = activePath
    try {
      flushSave()
      await deleteNote(vault, path)
      setActivePath(null)
      setContent('')
      setIndex((prev) => prev.filter((n) => n.path !== path))
      bumpDirty()
    } catch (e) {
      setError(String(e))
    }
  }

  /** Follow a `[[wiki-link]]`: open the matching note, or create it if missing. */
  async function followLink(target: string) {
    if (!vault) return
    const existing = resolveTarget(target, allPaths)
    if (existing) {
      void openNote(existing)
      return
    }
    const path = targetToNewPath(target)
    try {
      await createNote(vault, path)
      setNoteContent(path, '')
      bumpDirty()
      await openNote(path)
    } catch (e) {
      setError(String(e))
    }
  }

  function onPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    const tag = decodeTagHref(href)
    if (tag !== null) {
      e.preventDefault()
      activateTag(tag)
      return
    }
    const target = decodeWikiHref(href)
    if (target === null) return // ordinary link
    e.preventDefault()
    void followLink(target)
  }

  // Tags first, then wiki-links: the wiki transform emits `#wl:` hrefs that the
  // tag regex would otherwise rewrite.
  const previewHtml = useMemo(
    () => marked.parse(wikiLinksToMarkdown(tagsToMarkdown(content))) as string,
    [content],
  )

  if (!vault) {
    return (
      <main className="welcome">
        <h1>Notes</h1>
        <p>Choose a folder to use as your vault. Your notes are plain&nbsp;.md files on disk.</p>
        <button className="primary" onClick={chooseVault}>
          Open vault…
        </button>
      </main>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <span className="vault-name" title={vault}>
            {vault.split(/[\\/]/).pop() || vault}
          </span>
          <div className="sidebar-actions">
            <button title="New note" onClick={newNote}>
              ＋
            </button>
            <button title="New folder" onClick={newFolder}>
              📁
            </button>
            <button
              title="Graph view"
              className={showGraph ? 'active' : undefined}
              onClick={() => setShowGraph((s) => !s)}
            >
              🕸
            </button>
            <button title="Change vault" onClick={chooseVault}>
              ⌂
            </button>
          </div>
        </header>

        <input
          className="search"
          placeholder="Search notes…"
          value={query}
          onChange={(e) => {
            setTagFilter(null)
            setQuery(e.currentTarget.value)
          }}
        />

        {searchResults !== null ? (
          searchResults.length === 0 ? (
            <p className="empty">No matches.</p>
          ) : (
            <ul className="results">
              {searchResults.map((hit) => (
                <li
                  key={hit.path}
                  className={`tree-row file${activePath === hit.path ? ' active' : ''}`}
                  onClick={() => openNote(hit.path)}
                >
                  <span className="label">{noteName(hit.path)}</span>
                  {hit.snippet && (
                    <span
                      className="snippet"
                      dangerouslySetInnerHTML={{ __html: renderSnippet(hit.snippet) }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )
        ) : tagResults !== null ? (
          <>
            <div className="tag-filter">
              <span className="tag-chip">#{tagFilter}</span>
              <button title="Clear tag filter" onClick={() => setTagFilter(null)}>
                ✕
              </button>
            </div>
            {tagResults.length === 0 ? (
              <p className="empty">No notes with this tag.</p>
            ) : (
              <ul className="results">
                {tagResults.map((path) => (
                  <li
                    key={path}
                    className={`tree-row file${activePath === path ? ' active' : ''}`}
                    onClick={() => openNote(path)}
                  >
                    <span className="label">{noteName(path)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : notes.length === 0 && folders.length === 0 ? (
          <p className="empty">No notes yet. Create one with ＋.</p>
        ) : (
          <FileTree nodes={tree} activePath={activePath} onSelect={openNote} onMove={moveNote} />
        )}
        <SyncPanel vault={vault} onSynced={() => void loadIndex(vault)} editSignal={editTick} />
      </aside>

      <section className="main">
        {activePath ? (
          <>
            <header className="editor-head">
              <span className="title">{activePath}</span>
              {currentTags.map((tag) => (
                <button
                  key={tag}
                  className="tag-chip"
                  title={`Filter by #${tag}`}
                  onClick={() => activateTag(tag)}
                >
                  #{tag}
                </button>
              ))}
              <span className={`status ${status}`}>{status}</span>
              <button className="danger" title="Delete note" onClick={removeActive}>
                🗑
              </button>
            </header>
            <div className="panes">
              <Editor value={content} onChange={onEdit} noteNames={noteNames} />
              <div
                className="preview"
                onClick={onPreviewClick}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
            <footer className="backlinks">
              <span className="backlinks-head">Backlinks ({backlinks.length})</span>
              {backlinks.length === 0 ? (
                <span className="empty-inline">No notes link here yet.</span>
              ) : (
                <ul>
                  {backlinks.map((path) => (
                    <li key={path} onClick={() => openNote(path)}>
                      {noteName(path)}
                    </li>
                  ))}
                </ul>
              )}
            </footer>
          </>
        ) : (
          <div className="placeholder">Select a note, or create one with ＋.</div>
        )}
      </section>

      {showGraph && (
        <GraphView
          linkGraph={linkGraph}
          paths={allPaths}
          activePath={activePath}
          onSelect={openNote}
          onClose={() => setShowGraph(false)}
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

export default App
