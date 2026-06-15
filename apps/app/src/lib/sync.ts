import {
  emptySyncState,
  type ApiNote,
  type PushResult,
  type SyncFs,
  type SyncState,
  type SyncTransport,
} from '@notes/core'
import type { PushItem } from '@notes/core'
import { deleteNote, readAllNotes, readNote, writeNote } from './api'

/** Sidecar file holding per-vault sync bookkeeping. Hidden, so it never lists
 * as a note (the Rust walker skips dotfiles). */
const SYNC_STATE_FILE = '.notes-sync.json'

/** Filesystem port backed by the Tauri vault commands. */
export function makeTauriFs(vault: string): SyncFs {
  return {
    async list() {
      const notes = await readAllNotes(vault)
      return notes.map((n) => ({ path: n.path, content: n.content, updatedAt: n.modified }))
    },
    write: (path, content) => writeNote(vault, path, content),
    async remove(path) {
      try {
        await deleteNote(vault, path)
      } catch {
        // Already gone — sync treats removal as idempotent.
      }
    },
  }
}

/** Network port backed by `fetch` against the sync server. */
export function makeHttpTransport(baseUrl: string, token: string): SyncTransport {
  const base = baseUrl.replace(/\/+$/, '')
  const authHeaders = { Authorization: `Bearer ${token}` }
  return {
    async pull(cursor) {
      const res = await fetch(`${base}/sync/pull?cursor=${cursor}`, { headers: authHeaders })
      if (!res.ok) throw new Error(`pull failed (${res.status})`)
      return (await res.json()) as { changes: ApiNote[]; cursor: number }
    },
    async push(changes: PushItem[]) {
      const res = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      if (!res.ok) throw new Error(`push failed (${res.status})`)
      return (await res.json()) as { results: PushResult[]; cursor: number }
    },
  }
}

/** Load persisted sync state from the vault, or a fresh state if none exists. */
export async function loadSyncState(vault: string): Promise<SyncState> {
  try {
    return JSON.parse(await readNote(vault, SYNC_STATE_FILE)) as SyncState
  } catch {
    return emptySyncState()
  }
}

/** Persist sync state into the vault sidecar. */
export function saveSyncState(vault: string, state: SyncState): Promise<void> {
  return writeNote(vault, SYNC_STATE_FILE, JSON.stringify(state, null, 2))
}

/** Auth result returned by `/auth/login` and `/auth/register`. */
export interface AuthResult {
  token: string
  user: { id: string; email: string }
}

/** Log in or register against the server; returns a JWT + user. */
export async function authenticate(
  baseUrl: string,
  kind: 'login' | 'register',
  email: string,
  password: string,
): Promise<AuthResult> {
  const base = baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/auth/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `auth failed (${res.status})`)
  }
  return (await res.json()) as AuthResult
}
