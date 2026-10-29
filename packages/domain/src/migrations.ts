import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { AnyPgDatabase } from './scoped'

/** The drizzle-kit migrations folder, found from this file so it works whatever the working directory is. */
export const migrationsFolder = join(import.meta.dir, '../migrations')

interface JournalEntry {
  tag: string
  when: number
}

/**
 * The tags of the migrations in `migrations/` that the database has not
 * applied yet, oldest first; empty when it is up to date. It follows drizzle's
 * own migrator: a migration is pending when it is newer than the last one
 * recorded in `drizzle.__drizzle_migrations`, and all are pending when that
 * table doesn't exist. Throws when the database can't be queried.
 */
export async function checkMigrations(db: AnyPgDatabase, folder = migrationsFolder): Promise<string[]> {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: JournalEntry[] }
  const table = rowsOf(await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as found`))
  let last = Number.NEGATIVE_INFINITY
  if (table[0]?.found) {
    const applied = rowsOf(await db.execute(sql`select max(created_at) as last from drizzle.__drizzle_migrations`))
    if (applied[0]?.last != null) last = Number(applied[0].last)
  }
  return journal.entries.filter((entry) => entry.when > last).map((entry) => entry.tag)
}

// Bun's SQL driver returns the rows as an array; PGlite wraps them in `{ rows }`.
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result
  return (result as { rows?: Record<string, unknown>[] }).rows ?? []
}
