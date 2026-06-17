import type { ApiNote, PushItem } from '@notes/core'

/**
 * On-device persistence so Joke book works offline. The web client normally
 * keeps the whole vault only in memory and re-pulls it from the sync server on
 * every launch — useless without a connection. Here we mirror that vault into
 * IndexedDB (lives in the phone's storage) and keep an *outbox* of local edits
 * that haven't reached the server yet, so the app can be opened, read and
 * edited with no network and reconcile once it's back.
 *
 * One record per signed-in account (keyed by server + email) holds the full
 * snapshot: the notes, the pull cursor, and the pending outbox. We rewrite the
 * whole record on each change — at a joke-book's scale (hundreds of notes) this
 * is simpler and plenty fast, and it keeps the backup/restore format trivial.
 */

const DB_NAME = 'jokebook'
const STORE = 'vault'
const DB_VERSION = 1

export interface VaultSnapshot {
  /** Pull cursor (server rev) the cached notes are current as of. */
  cursor: number
  /** Every note known locally (including folder markers). */
  notes: ApiNote[]
  /** Local edits not yet acknowledged by the server, newest content per id. */
  outbox: PushItem[]
}

/** A device backup file: a tagged, versioned vault snapshot. */
export interface BackupFile extends VaultSnapshot {
  kind: 'jokebook-backup'
  version: 1
  /** Account the backup was taken from, for a friendly restore confirmation. */
  account?: string
  /** When the backup was written (epoch ms), stamped by the caller. */
  savedAt?: number
}

/** Stable per-account key so two accounts on one device don't collide. */
export function vaultKey(serverUrl: string, email: string): string {
  return `${serverUrl.replace(/\/+$/, '')}::${email.toLowerCase()}`
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (!('indexedDB' in globalThis)) return resolve(null)
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Read the cached snapshot for `key`, or `null` if none / IndexedDB is absent. */
export async function loadVault(key: string): Promise<VaultSnapshot | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as VaultSnapshot | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Persist the snapshot for `key`. Best-effort — failures are swallowed so a
 * storage hiccup never blocks editing. */
export async function saveVault(key: string, snap: VaultSnapshot): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      // Structured-clone-safe plain copy (drops any accidental proxies).
      tx.objectStore(STORE).put(
        { cursor: snap.cursor, notes: snap.notes, outbox: snap.outbox },
        key,
      )
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}
