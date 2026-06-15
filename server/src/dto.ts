import type { NoteRecord } from '@notes/core'
import type { NoteRow } from './db/schema.js'

/** Note as sent over the wire (server-storage `rev` included for cursoring). */
export interface ApiNote {
  id: string
  path: string
  content: string
  version: number
  updatedAt: number
  deleted: boolean
  rev: number
}

/** Per-item result of a push. */
export type ApiPushResult =
  | { id: string; status: 'applied'; note: ApiNote }
  | { id: string; status: 'applied_with_conflict'; note: ApiNote; losing: ApiNote }
  | { id: string; status: 'rejected_conflict'; note: ApiNote }

/** Strip storage-only columns to get the pure sync record. */
export function rowToRecord(row: NoteRow): NoteRecord {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    contentHash: row.contentHash,
    version: row.version,
    updatedAt: row.updatedAt,
    deleted: row.deleted,
  }
}

/** Combine a sync record with its server `rev` into the wire DTO. */
export function recordToApi(record: NoteRecord, rev: number): ApiNote {
  return {
    id: record.id,
    path: record.path,
    content: record.content,
    version: record.version,
    updatedAt: record.updatedAt,
    deleted: record.deleted,
    rev,
  }
}

export function rowToApi(row: NoteRow): ApiNote {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    version: row.version,
    updatedAt: row.updatedAt,
    deleted: row.deleted,
    rev: row.rev,
  }
}
