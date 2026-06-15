/**
 * Client-side synchronization engine.
 *
 * Pure orchestration over injected transport (network) and filesystem ports, so
 * it runs identically on desktop and mobile and is unit-testable without I/O.
 * Conflict resolution itself lives on the server (see {@link resolvePushItem});
 * this engine drives the push→pull cycle and turns server outcomes into local
 * file operations (writing conflict copies, adopting server versions, deletes).
 */
import { conflictCopyPath, hashContent, type PushItem } from './sync.js'

/** Note as sent over the wire by the server (mirrors `server/src/dto.ts`). */
export interface ApiNote {
  id: string
  path: string
  content: string
  version: number
  updatedAt: number
  deleted: boolean
  /** Server storage revision, used as the pull cursor. */
  rev: number
}

/** Per-item result of `POST /sync/push`. */
export type PushResult =
  | { id: string; status: 'applied'; note: ApiNote }
  | { id: string; status: 'applied_with_conflict'; note: ApiNote; losing: ApiNote }
  | { id: string; status: 'rejected_conflict'; note: ApiNote }

/** Network port. Implemented with `fetch` in the app, faked in tests. */
export interface SyncTransport {
  pull(cursor: number): Promise<{ changes: ApiNote[]; cursor: number }>
  push(changes: PushItem[]): Promise<{ results: PushResult[]; cursor: number }>
}

/** A local note as the sync engine sees it. */
export interface LocalNote {
  path: string
  content: string
  /** Epoch ms of the last local edit (file mtime), used for last-write-wins. */
  updatedAt: number
}

/** Filesystem port. Implemented with Tauri commands in the app, faked in tests. */
export interface SyncFs {
  /** Notes currently on disk (must exclude the sync-state sidecar). */
  list(): Promise<LocalNote[]>
  write(path: string, content: string): Promise<void>
  /** Delete a note; must not throw if the file is already gone. */
  remove(path: string): Promise<void>
}

/** Per-note bookkeeping the client persists between syncs. */
export interface NoteSyncMeta {
  id: string
  /** Vault-relative path last known for this note. */
  path: string
  /** Server version last observed (0 = never accepted by the server). */
  version: number
  /** Hash of the content last in sync with the server (change detection). */
  syncedHash: string
}

/** Persisted client sync state (stored as a sidecar JSON in the vault). */
export interface SyncState {
  /** Highest server `rev` pulled so far. */
  cursor: number
  /** Bookkeeping keyed by note id. */
  notes: Record<string, NoteSyncMeta>
}

/** What a sync run changed, for surfacing to the user. */
export interface SyncSummary {
  pushed: number
  pulled: number
  conflicts: number
}

export interface SyncOptions {
  /** New note-id generator (defaults to `crypto.randomUUID`). */
  newId?: () => string
  /** Current epoch ms (injectable for deterministic tests). */
  now?: () => number
}

/** A fresh, never-synced state. */
export function emptySyncState(): SyncState {
  return { cursor: 0, notes: {} }
}

/** Default id generator: the platform `crypto.randomUUID` (browser & Node 19+). */
function defaultNewId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  throw new Error('crypto.randomUUID is unavailable; pass opts.newId')
}

/**
 * Run one full sync cycle: push local changes (server resolves conflicts), then
 * pull remote changes. Works on a copy of `prev`; the returned `state` should be
 * persisted only after this resolves, so a failed sync leaves state untouched.
 */
export async function runSync(
  fs: SyncFs,
  transport: SyncTransport,
  prev: SyncState,
  opts: SyncOptions = {},
): Promise<{ state: SyncState; summary: SyncSummary }> {
  const newId = opts.newId ?? defaultNewId
  const now = opts.now ?? (() => Date.now())
  const stamp = () => new Date(now())

  const notes: Record<string, NoteSyncMeta> = {}
  for (const [id, m] of Object.entries(prev.notes)) notes[id] = { ...m }
  let cursor = prev.cursor
  const summary: SyncSummary = { pushed: 0, pulled: 0, conflicts: 0 }

  const local = await fs.list()
  const localByPath = new Map(local.map((n) => [n.path, n]))
  const metaByPath = new Map<string, NoteSyncMeta>()
  for (const m of Object.values(notes)) metaByPath.set(m.path, m)

  /** Adopt a server note locally (write/rename/delete) and update its meta. */
  const adoptServerNote = async (note: ApiNote) => {
    const meta = notes[note.id]
    if (note.deleted) {
      await fs.remove(meta?.path ?? note.path)
      delete notes[note.id]
      return
    }
    if (meta && meta.path !== note.path) await fs.remove(meta.path)
    await fs.write(note.path, note.content)
    notes[note.id] = {
      id: note.id,
      path: note.path,
      version: note.version,
      syncedHash: hashContent(note.content),
    }
  }

  // ---- 1. Collect local changes ----
  const changes: PushItem[] = []
  const seen = new Set<string>()
  for (const note of local) {
    const hash = hashContent(note.content)
    const meta = metaByPath.get(note.path)
    if (meta) {
      seen.add(meta.id)
      if (meta.syncedHash !== hash) {
        changes.push({
          id: meta.id,
          path: note.path,
          content: note.content,
          updatedAt: note.updatedAt,
          deleted: false,
          baseVersion: meta.version,
        })
      }
    } else {
      const id = newId()
      notes[id] = { id, path: note.path, version: 0, syncedHash: '' }
      seen.add(id)
      changes.push({
        id,
        path: note.path,
        content: note.content,
        updatedAt: note.updatedAt,
        deleted: false,
        baseVersion: 0,
      })
    }
  }
  // Deletions: tracked notes that no longer exist on disk.
  for (const meta of Object.values(notes)) {
    if (seen.has(meta.id)) continue
    if (meta.version > 0) {
      changes.push({
        id: meta.id,
        path: meta.path,
        content: '',
        updatedAt: now(),
        deleted: true,
        baseVersion: meta.version,
      })
    } else {
      delete notes[meta.id] // new note that vanished before ever syncing
    }
  }

  // ---- 2. Push ----
  // NB: pushing must NOT advance the pull cursor. The server assigns fresh revs
  // to our pushed notes, but those revs sit *above* server notes this device has
  // never pulled (e.g. a freshly-switched vault whose account already has notes).
  // Advancing the cursor past them would make the pull below skip them entirely.
  // Our own pushed notes come back in the pull and re-apply idempotently.
  // Revs the server assigned to (or already had for) our pushed notes. The pull
  // below starts from the old cursor and so re-serves these; skip them there to
  // avoid redundant writes and an inflated `pulled` count.
  const pushedRevs = new Set<number>()
  if (changes.length) {
    const { results } = await transport.push(changes)
    for (const r of results) {
      const note = r.note
      pushedRevs.add(note.rev)
      if (r.status === 'rejected_conflict') {
        // Server version wins. Preserve our rejected content as a conflict copy.
        const localPath = notes[note.id]?.path ?? note.path
        const localNote = localByPath.get(localPath)
        if (localNote && hashContent(localNote.content) !== hashContent(note.content)) {
          await fs.write(conflictCopyPath(localPath, stamp()), localNote.content)
          summary.conflicts++
        }
        await adoptServerNote(note)
        continue
      }
      if (r.status === 'applied_with_conflict') {
        // Our write won; the previous server content is kept as a conflict copy
        // (no meta → pushed as a new note on the next run).
        await fs.write(conflictCopyPath(r.losing.path, stamp()), r.losing.content)
        summary.conflicts++
      }
      if (note.deleted) {
        delete notes[note.id]
      } else {
        notes[note.id] = {
          id: note.id,
          path: note.path,
          version: note.version,
          syncedHash: hashContent(note.content),
        }
      }
      summary.pushed++
    }
  }

  // ---- 3. Pull ----
  const { changes: remote, cursor: pullCursor } = await transport.pull(cursor)
  for (const note of remote) {
    if (pushedRevs.has(note.rev)) continue // our own just-pushed write
    await adoptServerNote(note)
    summary.pulled++
  }
  cursor = Math.max(cursor, pullCursor)

  return { state: { cursor, notes }, summary }
}
