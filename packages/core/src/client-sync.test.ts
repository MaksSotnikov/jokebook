import { describe, expect, it } from 'vitest'
import {
  runSync,
  emptySyncState,
  type ApiNote,
  type LocalNote,
  type PushResult,
  type SyncFs,
  type SyncState,
  type SyncTransport,
} from './client-sync.js'
import { resolvePushItem, type NoteRecord, type PushItem } from './sync.js'

/**
 * In-memory server that mirrors `server/src/routes/sync.ts` exactly: it stores
 * records + a monotonic `rev`, resolves pushes with the shared
 * {@link resolvePushItem}, and serves pulls by `rev > cursor`.
 */
class FakeServer implements SyncTransport {
  private store = new Map<string, { record: NoteRecord; rev: number }>()
  private rev = 0

  private toApi(record: NoteRecord, rev: number): ApiNote {
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

  push(changes: PushItem[]): Promise<{ results: PushResult[]; cursor: number }> {
    const results: PushResult[] = []
    for (const item of changes) {
      const existing = this.store.get(item.id)
      const outcome = resolvePushItem(existing?.record, item)
      if (outcome.status === 'rejected_conflict') {
        results.push({ id: item.id, status: 'rejected_conflict', note: this.toApi(existing!.record, existing!.rev) })
        continue
      }
      this.rev += 1
      this.store.set(outcome.record.id, { record: outcome.record, rev: this.rev })
      if (outcome.status === 'applied_with_conflict') {
        results.push({
          id: item.id,
          status: 'applied_with_conflict',
          note: this.toApi(outcome.record, this.rev),
          losing: this.toApi(outcome.losing, existing!.rev),
        })
      } else {
        results.push({ id: item.id, status: 'applied', note: this.toApi(outcome.record, this.rev) })
      }
    }
    const cursor = results.reduce((m, r) => Math.max(m, r.note.rev), 0)
    return Promise.resolve({ results, cursor })
  }

  pull(cursor: number): Promise<{ changes: ApiNote[]; cursor: number }> {
    const changes = [...this.store.values()]
      .filter((e) => e.rev > cursor)
      .sort((a, b) => a.rev - b.rev)
      .map((e) => this.toApi(e.record, e.rev))
    const newCursor = changes.length ? changes[changes.length - 1].rev : cursor
    return Promise.resolve({ changes, cursor: newCursor })
  }
}

/** In-memory vault. `updatedAt` is explicit so we can drive last-write-wins. */
class FakeFs implements SyncFs {
  files = new Map<string, { content: string; updatedAt: number }>()

  put(path: string, content: string, updatedAt: number) {
    this.files.set(path, { content, updatedAt })
  }

  list(): Promise<LocalNote[]> {
    return Promise.resolve(
      [...this.files].map(([path, f]) => ({ path, content: f.content, updatedAt: f.updatedAt })),
    )
  }

  write(path: string, content: string): Promise<void> {
    const prev = this.files.get(path)
    this.files.set(path, { content, updatedAt: prev?.updatedAt ?? 0 })
    return Promise.resolve()
  }

  remove(path: string): Promise<void> {
    this.files.delete(path)
    return Promise.resolve()
  }
}

/**
 * Deterministic id generator + clock. One harness per test keeps a single,
 * monotonic id sequence (real ids are globally-unique UUIDs); `at(time)` builds
 * the options for an individual sync run at a chosen wall-clock time.
 */
function harness() {
  let n = 0
  const newId = () => `id-${++n}`
  return {
    at: (time: number) => ({ newId, now: () => time }),
  }
}

describe('runSync', () => {
  it('pushes a new local note, then a second device pulls it', async () => {
    const server = new FakeServer()
    const h = harness()

    // Device A creates and syncs a note.
    const a = new FakeFs()
    a.put('Hello.md', '# Hello', 100)
    const ra = await runSync(a, server, emptySyncState(), h.at(100))
    expect(ra.summary.pushed).toBe(1)
    const aMeta = Object.values(ra.state.notes)[0]
    expect(aMeta.version).toBe(1)

    // Device B starts empty and pulls it down.
    const b = new FakeFs()
    const rb = await runSync(b, server, emptySyncState(), h.at(100))
    expect(rb.summary.pulled).toBe(1)
    expect(b.files.get('Hello.md')?.content).toBe('# Hello')
    // Both devices agree on the note id.
    expect(Object.keys(rb.state.notes)).toEqual([aMeta.id])
  })

  it('pulls pre-existing remote notes even when the device also has notes to push', async () => {
    // Regression: a freshly-switched vault that has its own local notes used to
    // advance the cursor past server notes it had never seen, so the pull skipped
    // them. After pushing its own notes, it must still pull everything remote.
    const server = new FakeServer()
    const h = harness()

    // Device A seeds three notes onto the account.
    const a = new FakeFs()
    a.put('A1.md', 'one', 100)
    a.put('A2.md', 'two', 100)
    a.put('A3.md', 'three', 100)
    await runSync(a, server, emptySyncState(), h.at(100))

    // Device B is a different vault with its own note and a fresh sync state.
    const b = new FakeFs()
    b.put('B1.md', 'mine', 200)
    const rb = await runSync(b, server, emptySyncState(), h.at(200))

    // B pushed its own note AND pulled all three of A's notes.
    expect(rb.summary.pushed).toBe(1)
    expect(rb.summary.pulled).toBe(3)
    expect([...b.files.keys()].sort()).toEqual(['A1.md', 'A2.md', 'A3.md', 'B1.md'])
  })

  it('keeps both versions on a genuine conflict (last-write-wins + conflict copy)', async () => {
    const server = new FakeServer()
    const h = harness()

    // Seed a shared note onto both devices.
    const a = new FakeFs()
    a.put('Note.md', 'base', 100)
    const sa: SyncState = (await runSync(a, server, emptySyncState(), h.at(100))).state
    const b = new FakeFs()
    let sb: SyncState = (await runSync(b, server, emptySyncState(), h.at(100))).state
    expect(b.files.get('Note.md')?.content).toBe('base')

    // Both edit offline; A's edit is newer (wins LWW).
    a.put('Note.md', 'from A', 300)
    b.put('Note.md', 'from B', 200)

    // A syncs first → accepted at version 2.
    await runSync(a, server, sa, h.at(300))

    // B syncs → its push is rejected; B adopts A's content and keeps its own as a copy.
    const rb = await runSync(b, server, sb, h.at(500))
    sb = rb.state
    expect(rb.summary.conflicts).toBe(1)
    expect(b.files.get('Note.md')?.content).toBe('from A')
    const conflictFile = [...b.files.keys()].find((p) => p.includes('conflict'))
    expect(conflictFile).toBeDefined()
    expect(b.files.get(conflictFile!)?.content).toBe('from B')

    // Convergence: another B sync pushes the conflict copy with no further conflicts.
    const rb2 = await runSync(b, server, sb, h.at(600))
    expect(rb2.summary.conflicts).toBe(0)
  })

  it('propagates a deletion to the other device', async () => {
    const server = new FakeServer()
    const h = harness()

    const a = new FakeFs()
    a.put('Doomed.md', 'bye', 100)
    let sa = (await runSync(a, server, emptySyncState(), h.at(100))).state
    const b = new FakeFs()
    let sb = (await runSync(b, server, emptySyncState(), h.at(100))).state
    expect(b.files.has('Doomed.md')).toBe(true)

    // A deletes the file and syncs.
    a.remove('Doomed.md')
    sa = (await runSync(a, server, sa, h.at(200))).state
    expect(Object.keys(sa.notes)).toHaveLength(0)

    // B pulls the tombstone and removes its local copy.
    const rb = await runSync(b, server, sb, h.at(200))
    sb = rb.state
    expect(b.files.has('Doomed.md')).toBe(false)
    expect(Object.keys(sb.notes)).toHaveLength(0)
  })
})
