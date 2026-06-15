import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/** Registered users. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Synced notes. One row per note per user. `id` is the client-generated note
 * id (so the same note has a stable id across devices). `rev` is a per-user
 * monotonic counter used as the pull cursor.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    version: integer('version').notNull(),
    /** Epoch milliseconds of the last edit (last-write-wins key). */
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted: boolean('deleted').notNull().default(false),
    /** Per-user monotonic write counter; clients pull everything with rev > cursor. */
    rev: bigint('rev', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.id] }),
    userRevIdx: index('notes_user_rev_idx').on(t.userId, t.rev),
  }),
)

export type UserRow = typeof users.$inferSelect
export type NoteRow = typeof notes.$inferSelect
