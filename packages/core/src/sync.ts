/**
 * Core synchronization model and conflict-resolution logic.
 *
 * This module is pure (no I/O) so it can run identically on the client and the
 * server and be unit-tested in isolation. Storage and transport live elsewhere
 * (Tauri/SQLite on the client, Fastify/Postgres on the server).
 */

/** Canonical representation of a note as tracked by the sync layer. */
export interface NoteRecord {
  /** Stable note id (uuid), assigned on creation and never reused. */
  id: string
  /** Vault-relative path, e.g. `"folder/My Note.md"`. */
  path: string
  /** Full markdown content. */
  content: string
  /** Stable hash of `content`, used for cheap change detection. */
  contentHash: string
  /** Server-assigned version; increments on every accepted write. 0 = never synced. */
  version: number
  /** Epoch milliseconds of the last edit (used for last-write-wins). */
  updatedAt: number
  /** Tombstone flag — a deleted note is kept as a record so deletes propagate. */
  deleted: boolean
}

/** A change the client wants to push to the server. */
export interface PushItem {
  id: string
  path: string
  content: string
  updatedAt: number
  deleted: boolean
  /** Server version the client last observed for this note (0 if new). */
  baseVersion: number
}

/** Outcome of applying a single {@link PushItem} against the server state. */
export type PushOutcome =
  /** Applied cleanly — no concurrent server change. */
  | { id: string; status: 'applied'; record: NoteRecord }
  /**
   * Client write was newer than a concurrent server change and won (LWW).
   * The previous server record is returned so the client can keep it as a
   * conflict copy and lose no data.
   */
  | { id: string; status: 'applied_with_conflict'; record: NoteRecord; losing: NoteRecord }
  /**
   * A concurrent server change was newer and won. The client must adopt
   * `record` and keep its own rejected content as a conflict copy.
   */
  | { id: string; status: 'rejected_conflict'; record: NoteRecord }

/**
 * Stable, fast, non-cryptographic content hash (FNV-1a, 64-bit) rendered as
 * hex. Deterministic across platforms and runtimes — used only to detect
 * whether content changed, not for security.
 */
export function hashContent(content: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < content.length; i++) {
    hash ^= BigInt(content.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Resolve a single client push against the current server record (or
 * `undefined` if the note is new to the server). Pure: returns the outcome and
 * the next server record; the caller persists it.
 */
export function resolvePushItem(server: NoteRecord | undefined, item: PushItem): PushOutcome {
  const contentHash = hashContent(item.content)

  // New note, or the client is in sync with the server's current version:
  // accept and bump the version.
  if (!server || item.baseVersion === server.version) {
    const record: NoteRecord = {
      id: item.id,
      path: item.path,
      content: item.content,
      contentHash,
      version: (server?.version ?? 0) + 1,
      updatedAt: item.updatedAt,
      deleted: item.deleted,
    }
    return { id: item.id, status: 'applied', record }
  }

  // Concurrent change: the server moved on since the client's baseVersion.
  // If the client and server actually agree on content, there is no real
  // conflict — just fast-forward the client onto the server version.
  if (server.contentHash === contentHash && server.deleted === item.deleted) {
    return { id: item.id, status: 'applied', record: server }
  }

  // Genuine conflict — resolve by last-write-wins on updatedAt.
  const clientWins = item.updatedAt > server.updatedAt
  if (clientWins) {
    const record: NoteRecord = {
      id: item.id,
      path: item.path,
      content: item.content,
      contentHash,
      version: server.version + 1,
      updatedAt: item.updatedAt,
      deleted: item.deleted,
    }
    return { id: item.id, status: 'applied_with_conflict', record, losing: server }
  }

  // Server wins: client must adopt the server record and keep its own copy.
  return { id: item.id, status: 'rejected_conflict', record: server }
}

/** Build the conflict-copy path for a losing note version, e.g.
 * `"Note.md"` → `"Note (conflict 2026-06-14 13-05-22).md"`. */
export function conflictCopyPath(path: string, when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  const dot = path.lastIndexOf('.')
  if (dot <= 0) return `${path} (conflict ${stamp})`
  return `${path.slice(0, dot)} (conflict ${stamp})${path.slice(dot)}`
}
