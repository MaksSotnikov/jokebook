import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import fastifyCors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Database } from './db/index.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerSyncRoutes } from './routes/sync.js'

export interface AppDeps {
  db: Database
  jwtSecret: string
  logger?: boolean
  /** Allowed CORS origin(s); defaults to reflecting any origin (dev-friendly).
   * Auth uses bearer tokens (no cookies), so a permissive default is safe. */
  corsOrigin?: boolean | string | string[]
  /** Absolute path to a built web client (`apps/web/dist`) to serve statically.
   * When set, the SPA is served at `/` so a phone can reach it on the same
   * origin as the API. Omitted in tests. */
  webRoot?: string
}

/** Build a configured Fastify instance (does not listen). */
export function buildApp({
  db,
  jwtSecret,
  logger = false,
  corsOrigin = true,
  webRoot,
}: AppDeps): FastifyInstance {
  const app = Fastify({ logger })

  app.register(fastifyCors, { origin: corsOrigin })
  app.register(fastifyJwt, { secret: jwtSecret })

  app.decorate('authenticate', async (req, reply) => {
    try {
      await req.jwtVerify()
    } catch {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/health', async () => ({ status: 'ok' }))
  app.register(registerAuthRoutes, { db })
  app.register(registerSyncRoutes, { db })

  if (webRoot && existsSync(webRoot)) registerWebRoot(app, webRoot)

  return app
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

/**
 * Serve the built web client. A low-priority `GET /*` wildcard sits below the
 * API routes (Fastify prefers the more specific `/health`, `/auth/*`, `/sync/*`),
 * streams a matching file from `webRoot`, and otherwise falls back to
 * `index.html` so the SPA loads. Hashed assets get a long cache; HTML does not.
 */
function registerWebRoot(app: FastifyInstance, webRoot: string) {
  const root = normalize(webRoot)
  const indexHtml = join(root, 'index.html')

  app.get('/*', async (req, reply) => {
    const rel = decodeURIComponent((req.params as { '*': string })['*'] || '')
    const candidate = normalize(join(root, rel))
    // Guard against path traversal escaping the web root.
    const inRoot = candidate === root || candidate.startsWith(root + sep)
    const file = inRoot && rel && existsSync(candidate) ? candidate : indexHtml

    const body = await readFile(file)
    reply.type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
    if (file !== indexHtml && rel.startsWith('assets/')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      reply.header('Cache-Control', 'no-cache')
    }
    return reply.send(body)
  })
}
