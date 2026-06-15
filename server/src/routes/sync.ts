import { resolvePushItem, type NoteRecord, type PushItem } from '@notes/core'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/index.js'
import { notes } from '../db/schema.js'
import { recordToApi, rowToApi, rowToRecord, type ApiPushResult } from '../dto.js'

const pullQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
})

const pushBodySchema = z.object({
  changes: z.array(
    z.object({
      id: z.string().uuid(),
      path: z.string().min(1),
      content: z.string(),
      updatedAt: z.number().int().nonnegative(),
      deleted: z.boolean(),
      baseVersion: z.number().int().nonnegative(),
    }),
  ),
})

export async function registerSyncRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts

  // Return every change with rev greater than the client's cursor.
  app.get('/sync/pull', { onRequest: [app.authenticate] }, async (req, reply) => {
    const parsed = pullQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_cursor' })
    const userId = req.user.sub
    const { cursor } = parsed.data

    const rows = await db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), gt(notes.rev, cursor)))
      .orderBy(notes.rev)

    const changes = rows.map(rowToApi)
    const newCursor = rows.length ? rows[rows.length - 1].rev : cursor
    return { changes, cursor: newCursor }
  })

  // Apply client changes with per-item conflict resolution (see @notes/core).
  app.post('/sync/push', { onRequest: [app.authenticate] }, async (req, reply) => {
    const parsed = pushBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_push' })
    const userId = req.user.sub
    const items = parsed.data.changes as PushItem[]

    const results = await db.transaction(async (tx) => {
      const [{ maxRev }] = await tx
        .select({ maxRev: sql<number>`coalesce(max(${notes.rev}), 0)` })
        .from(notes)
        .where(eq(notes.userId, userId))
      let rev = Number(maxRev)
      const out: ApiPushResult[] = []

      for (const item of items) {
        const [existing] = await tx
          .select()
          .from(notes)
          .where(and(eq(notes.userId, userId), eq(notes.id, item.id)))
        const server: NoteRecord | undefined = existing ? rowToRecord(existing) : undefined
        const outcome = resolvePushItem(server, item)

        if (outcome.status === 'rejected_conflict') {
          // Server version wins; nothing written. Client adopts this note and
          // keeps its own rejected content as a conflict copy.
          out.push({ id: item.id, status: 'rejected_conflict', note: rowToApi(existing) })
          continue
        }

        rev += 1
        const rec = outcome.record
        await tx
          .insert(notes)
          .values({
            id: rec.id,
            userId,
            path: rec.path,
            content: rec.content,
            contentHash: rec.contentHash,
            version: rec.version,
            updatedAt: rec.updatedAt,
            deleted: rec.deleted,
            rev,
          })
          .onConflictDoUpdate({
            target: [notes.userId, notes.id],
            set: {
              path: rec.path,
              content: rec.content,
              contentHash: rec.contentHash,
              version: rec.version,
              updatedAt: rec.updatedAt,
              deleted: rec.deleted,
              rev,
            },
          })

        if (outcome.status === 'applied_with_conflict') {
          out.push({
            id: item.id,
            status: 'applied_with_conflict',
            note: recordToApi(rec, rev),
            losing: recordToApi(outcome.losing, existing!.rev),
          })
        } else {
          out.push({ id: item.id, status: 'applied', note: recordToApi(rec, rev) })
        }
      }
      return out
    })

    const cursor = results.reduce((max, r) => Math.max(max, r.note.rev), 0)
    return { results, cursor }
  })
}
