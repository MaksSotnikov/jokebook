import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** A `.md` note as listed from the vault. */
export interface NoteEntry {
  /** Vault-relative path with forward slashes, e.g. `"folder/My Note.md"`. */
  path: string
  /** Basename without the `.md` extension. */
  name: string
}

/** Open the native folder picker; resolves to the chosen path or `null`. */
export async function pickVault(): Promise<string | null> {
  return (await invoke<string | null>('pick_vault')) ?? null
}

/** List every `.md` note in the vault. */
export function listNotes(vault: string): Promise<NoteEntry[]> {
  return invoke<NoteEntry[]>('list_notes', { vault })
}

/** A note's path together with its full content and last-modified time. */
export interface NoteContent {
  path: string
  content: string
  /** Last-modified time in epoch milliseconds (drives last-write-wins on sync). */
  modified: number
}

/** Read every note's content in one call (for the link / search index). */
export function readAllNotes(vault: string): Promise<NoteContent[]> {
  return invoke<NoteContent[]>('read_all_notes', { vault })
}

/** Read a note's content. */
export function readNote(vault: string, path: string): Promise<string> {
  return invoke<string>('read_note', { vault, path })
}

/** Write (create or overwrite) a note. */
export function writeNote(vault: string, path: string, content: string): Promise<void> {
  return invoke('write_note', { vault, path, content })
}

/** Create a new empty note (fails if it already exists). */
export function createNote(vault: string, path: string): Promise<void> {
  return invoke('create_note', { vault, path })
}

/** Delete a note. */
export function deleteNote(vault: string, path: string): Promise<void> {
  return invoke('delete_note', { vault, path })
}

/** Rename / move a note. */
export function renameNote(vault: string, from: string, to: string): Promise<void> {
  return invoke('rename_note', { vault, from, to })
}

/** List every folder in the vault (vault-relative paths), including empty ones. */
export function listFolders(vault: string): Promise<string[]> {
  return invoke<string[]>('list_folders', { vault })
}

/** Create a folder (and any missing parents); fails if it already exists. */
export function createFolder(vault: string, path: string): Promise<void> {
  return invoke('create_folder', { vault, path })
}

/** Remove a folder (only if empty); used when sync adopts a folder deletion. */
export function removeFolder(vault: string, path: string): Promise<void> {
  return invoke('remove_folder', { vault, path })
}

/** Rebuild the full-text search index from the vault on disk. */
export function indexVault(vault: string): Promise<void> {
  return invoke('index_vault', { vault })
}

/** A search result: the note's path and a highlighted body snippet. */
export interface SearchHit {
  path: string
  /** Body snippet with matches wrapped in U+0002 / U+0003 control chars. */
  snippet: string
}

/** Ranked full-text search over note names and bodies. */
export function searchNotes(query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search_notes', { query })
}

/** Start watching `vault` for on-disk changes (replaces any prior watcher). */
export function watchVault(vault: string): Promise<void> {
  return invoke('watch_vault', { vault })
}

/** Subscribe to `vault-changed` events; resolves to an unlisten function. */
export function onVaultChanged(handler: () => void): Promise<UnlistenFn> {
  return listen('vault-changed', () => handler())
}
