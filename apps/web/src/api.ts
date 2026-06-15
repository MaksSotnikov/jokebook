import type { ApiNote, PushItem, PushResult } from '@notes/core'

/**
 * HTTP client for the sync server. Unlike the desktop app (which talks to a
 * local vault through Tauri), the web client has no filesystem: the user's
 * server account *is* the vault. Notes are read with `/sync/pull` and written
 * with `/sync/push`; auth yields a JWT carried as a bearer token.
 */

/** Normalize a configured server URL (empty = same origin as the page). */
function normBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '')
}

export interface AuthResult {
  token: string
  user: { id: string; email: string }
}

/** Log in or register; returns a JWT + user, or throws with the server error. */
export async function authenticate(
  serverUrl: string,
  kind: 'login' | 'register',
  email: string,
  password: string,
): Promise<AuthResult> {
  const res = await fetch(`${normBase(serverUrl)}/auth/${kind}`, {
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

/** Fetch every change with `rev` above `cursor` (cursor 0 = full snapshot). */
export async function pull(
  serverUrl: string,
  token: string,
  cursor: number,
): Promise<{ changes: ApiNote[]; cursor: number }> {
  const res = await fetch(`${normBase(serverUrl)}/sync/pull?cursor=${cursor}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`pull failed (${res.status})`)
  return (await res.json()) as { changes: ApiNote[]; cursor: number }
}

/** Push local changes; the server resolves conflicts per item. */
export async function push(
  serverUrl: string,
  token: string,
  changes: PushItem[],
): Promise<{ results: PushResult[]; cursor: number }> {
  const res = await fetch(`${normBase(serverUrl)}/sync/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`push failed (${res.status})`)
  return (await res.json()) as { results: PushResult[]; cursor: number }
}

/** Thrown when the server rejects the token, so the UI can log out cleanly. */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}
