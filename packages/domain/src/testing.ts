import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { buildDomain } from './domain'
import { migrationsFolder } from './migrations'
import * as schema from './schemas'
import type { ScopedTable } from './scoped'
import { type ScopedTables, scopedTables } from './scoped-tables'

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

/** Options for `createTestDomain`. */
export interface TestDomainOptions<Extra extends Record<string, ScopedTable>> {
  /** Test-only tables to scope next to the registered ones. Create them in the database before use. */
  scopedTables?: Extra
  /** Receives the line logged on each `skipAuthorization` call. */
  log?: (message: string) => void
}

/**
 * Creates a `Domain` on a fresh, migrated in-memory database, the same shape
 * `createDomain` returns. Call `close()` when the test is done.
 */
export async function createTestDomain<Extra extends Record<string, ScopedTable> = Record<never, ScopedTable>>(
  options: TestDomainOptions<Extra> = {},
) {
  const db = await createTestDb()
  const tables = { ...scopedTables, ...options.scopedTables } as ScopedTables & Extra
  return buildDomain(db, tables, db.close, options.log)
}

/** A domain from `createTestDomain`. */
export type TestDomain<Extra extends Record<string, ScopedTable> = Record<never, ScopedTable>> = Awaited<
  ReturnType<typeof createTestDomain<Extra>>
>
