import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { migrationsFolder } from './migrations'
import * as schema from './schemas'

/**
 * Creates a Drizzle client on a fresh in-memory Postgres (PGlite) with every
 * migration applied, so tests need no Docker and never touch `DATABASE_URL`.
 * Each call gets its own database. Call `close()` when the test is done.
 */
export async function createTestDb() {
  const db = drizzle({ client: new PGlite(), schema })
  await migrate(db, { migrationsFolder })
  return Object.assign(db, { close: () => db.$client.close() })
}

/** A database from `createTestDb`. */
export type TestDb = Awaited<ReturnType<typeof createTestDb>>
