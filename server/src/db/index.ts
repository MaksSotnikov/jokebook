import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

/**
 * The Drizzle database type used throughout the server. The production driver
 * is postgres-js; tests inject a PGlite-backed instance cast to this type (the
 * query API is identical at runtime).
 */
export type Database = PostgresJsDatabase<typeof schema>

/** Create a production database handle from a Postgres connection string. */
export function createPostgresDb(url: string): { db: Database; close: () => Promise<void> } {
  const client = postgres(url)
  const db = drizzle(client, { schema })
  return { db, close: () => client.end() }
}

export { schema }
