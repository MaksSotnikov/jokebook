import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Database } from '../src/db/index.js'
import { schema } from '../src/db/index.js'

let app: FastifyInstance
let token: string
const noteId = '11111111-1111-1111-1111-111111111111'

beforeAll(async () => {
  const client = new PGlite()
  const db = drizzle(client, { schema }) as unknown as Database
  await migrate(db, { migrationsFolder: './drizzle' })
  app = buildApp({ db, jwtSecret: 'test-secret' })
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: 'a@example.com', password: 'password123' },
  })
  expect(res.statusCode).toBe(201)
  token = res.json().token
})

afterAll(async () => {
  await app.close()
})

const auth = () => ({ authorization: `Bearer ${token}` })

const push = (changes: unknown[]) =>
  app.inject({ method: 'POST', url: '/sync/push', headers: auth(), payload: { changes } })

const pull = (cursor = 0) =>
  app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: auth() })

describe('auth', () => {
  it('rejects a duplicate email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@example.com', password: 'password123' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('guards sync routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/sync/pull?cursor=0' })
    expect(res.statusCode).toBe(401)
  })
})

describe('sync', () => {
  it('pushes a new note and pulls it back', async () => {
    const res = await push([
      {
        id: noteId,
        path: 'Hello.md',
        content: '# Hello',
        updatedAt: 1000,
        deleted: false,
        baseVersion: 0,
      },
    ])
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results[0]).toMatchObject({ status: 'applied' })
    expect(body.results[0].note.version).toBe(1)

    const pulled = (await pull(0)).json()
    expect(pulled.changes).toHaveLength(1)
    expect(pulled.changes[0]).toMatchObject({ id: noteId, content: '# Hello', version: 1 })
    expect(pulled.cursor).toBeGreaterThan(0)
  })

  it('does not re-pull already-synced notes past the cursor', async () => {
    const cursor = (await pull(0)).json().cursor
    const again = (await pull(cursor)).json()
    expect(again.changes).toHaveLength(0)
    expect(again.cursor).toBe(cursor)
  })

  it('resolves a conflict in favour of the newer write and keeps the loser', async () => {
    // Client still thinks it is on baseVersion 0 but server is at v1 — concurrent.
    const res = await push([
      {
        id: noteId,
        path: 'Hello.md',
        content: '# Hello (edited on device B)',
        updatedAt: 5000, // newer than the server's 1000 → client wins
        deleted: false,
        baseVersion: 0,
      },
    ])
    const result = res.json().results[0]
    expect(result.status).toBe('applied_with_conflict')
    expect(result.note.content).toBe('# Hello (edited on device B)')
    expect(result.note.version).toBe(2)
    expect(result.losing.content).toBe('# Hello')
  })

  it('rejects an older conflicting write (server wins)', async () => {
    const res = await push([
      {
        id: noteId,
        path: 'Hello.md',
        content: '# stale edit',
        updatedAt: 2000, // older than server's current 5000 → server wins
        deleted: false,
        baseVersion: 0,
      },
    ])
    const result = res.json().results[0]
    expect(result.status).toBe('rejected_conflict')
    expect(result.note.content).toBe('# Hello (edited on device B)')
  })
})
