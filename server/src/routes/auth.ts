import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashPassword, verifyPassword } from '../auth.js'
import type { Database } from '../db/index.js'
import { users } from '../db/schema.js'

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export async function registerAuthRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts

  app.post('/auth/register', async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credentials' })
    const { email, password } = parsed.data

    const existing = await db.select().from(users).where(eq(users.email, email))
    if (existing.length) return reply.code(409).send({ error: 'email_taken' })

    const passwordHash = await hashPassword(password)
    const [u] = await db.insert(users).values({ email, passwordHash }).returning()
    const token = await app.jwt.sign({ sub: u.id, email })
    return reply.code(201).send({ token, user: { id: u.id, email } })
  })

  app.post('/auth/login', async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credentials' })
    const { email, password } = parsed.data

    const [u] = await db.select().from(users).where(eq(users.email, email))
    if (!u || !(await verifyPassword(u.passwordHash, password))) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    const token = await app.jwt.sign({ sub: u.id, email })
    return { token, user: { id: u.id, email } }
  })
}
