import { describe, expect, it } from 'vitest'
import { conflictCopyPath, hashContent, resolvePushItem, type NoteRecord } from './sync.js'

const baseServer = (over: Partial<NoteRecord> = {}): NoteRecord => ({
  id: 'n1',
  path: 'Note.md',
  content: 'server content',
  contentHash: hashContent('server content'),
  version: 3,
  updatedAt: 1000,
  deleted: false,
  ...over,
})

const push = (over: Partial<Parameters<typeof resolvePushItem>[1]> = {}) => ({
  id: 'n1',
  path: 'Note.md',
  content: 'client content',
  updatedAt: 2000,
  deleted: false,
  baseVersion: 3,
  ...over,
})

describe('hashContent', () => {
  it('is deterministic and differs by content', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'))
    expect(hashContent('abc')).not.toBe(hashContent('abd'))
    expect(hashContent('')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('resolvePushItem', () => {
  it('applies a brand-new note at version 1', () => {
    const out = resolvePushItem(undefined, push({ baseVersion: 0 }))
    expect(out.status).toBe('applied')
    expect(out.record.version).toBe(1)
  })

  it('applies cleanly when client is on the current version', () => {
    const out = resolvePushItem(baseServer(), push({ baseVersion: 3 }))
    expect(out.status).toBe('applied')
    expect(out.record.version).toBe(4)
    expect(out.record.content).toBe('client content')
  })

  it('fast-forwards without conflict when content already matches', () => {
    const server = baseServer({ version: 5, content: 'same', contentHash: hashContent('same') })
    const out = resolvePushItem(server, push({ baseVersion: 3, content: 'same' }))
    expect(out.status).toBe('applied')
    expect(out.record.version).toBe(5)
  })

  it('client wins LWW when newer; returns losing server copy', () => {
    const server = baseServer({ version: 7, updatedAt: 1000 })
    const out = resolvePushItem(server, push({ baseVersion: 3, updatedAt: 2000 }))
    expect(out.status).toBe('applied_with_conflict')
    if (out.status === 'applied_with_conflict') {
      expect(out.record.version).toBe(8)
      expect(out.record.content).toBe('client content')
      expect(out.losing.content).toBe('server content')
    }
  })

  it('server wins LWW when newer; client must adopt server record', () => {
    const server = baseServer({ version: 7, updatedAt: 5000 })
    const out = resolvePushItem(server, push({ baseVersion: 3, updatedAt: 2000 }))
    expect(out.status).toBe('rejected_conflict')
    expect(out.record.content).toBe('server content')
    expect(out.record.version).toBe(7)
  })

  it('treats deletes as conflicting changes', () => {
    const server = baseServer({ version: 7, updatedAt: 1000 })
    const out = resolvePushItem(server, push({ baseVersion: 3, updatedAt: 9000, deleted: true }))
    expect(out.status).toBe('applied_with_conflict')
    expect(out.record.deleted).toBe(true)
  })
})

describe('conflictCopyPath', () => {
  it('inserts a timestamped suffix before the extension', () => {
    const when = new Date(2026, 5, 14, 13, 5, 22) // local time
    expect(conflictCopyPath('folder/Note.md', when)).toBe(
      'folder/Note (conflict 2026-06-14 13-05-22).md',
    )
  })

  it('handles paths without an extension', () => {
    const when = new Date(2026, 0, 1, 0, 0, 0)
    expect(conflictCopyPath('Note', when)).toBe('Note (conflict 2026-01-01 00-00-00)')
  })
})
