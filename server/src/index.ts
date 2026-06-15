import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { createPostgresDb, schema, type Database } from './db/index.js'

const databaseUrl = process.env.DATABASE_URL
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-change-me'
const port = Number(process.env.PORT ?? 3001)
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
// Serve the built web client (apps/web/dist) when present, so a phone can open
// the app on the same origin as the API. Path resolves the same from src (dev)
// and dist (prod) since both sit one level under server/.
const webRoot = fileURLToPath(new URL('../../apps/web/dist', import.meta.url))

let db: Database

if (databaseUrl) {
  // Production / prod-like: real Postgres via postgres-js.
  db = createPostgresDb(databaseUrl).db
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')
  await migrate(db, { migrationsFolder })
  console.log('[server] using Postgres')
} else {
  // No DATABASE_URL → zero-setup local dev backed by file-persisted PGlite
  // (Postgres compiled to WASM, in-process). No Docker or Postgres install
  // needed; the same drizzle migrations apply since PGlite *is* Postgres.
  const dataDir = process.env.PGLITE_DIR ?? fileURLToPath(new URL('../.pglite-data', import.meta.url))
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  const client = new PGlite(dataDir)
  const pgliteDb = drizzle(client, { schema })
  await migrate(pgliteDb, { migrationsFolder })
  db = pgliteDb as unknown as Database
  console.log(`[server] using PGlite (dev) — data at ${dataDir}`)
}

const app = buildApp({ db, jwtSecret, logger: true, webRoot })

try {
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`@notes/server listening on :${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
