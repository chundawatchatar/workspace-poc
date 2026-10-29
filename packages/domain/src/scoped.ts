import { and, eq, getTableColumns, type InferInsertModel, type InferSelectModel, is, type SQL } from 'drizzle-orm'
import { type PgColumn, type PgDatabase, type PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core'

/** Any Drizzle Postgres client, whatever its driver and schema. */
// biome-ignore lint/suspicious/noExplicitAny: the repositories never use the schema, so any schema is accepted.
export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, any>

/** A table owned by one user: it has a `userId` column. */
export type ScopedTable = PgTable & { userId: PgColumn }

/** Values for a new row. `userId` is left out: it always comes from the principal. */
export type ScopedInsert<T extends ScopedTable> = Omit<InferInsertModel<T>, 'userId'>

/** Columns to change on a row. `userId` is left out, so a row can never move to another user. */
export type ScopedUpdate<T extends ScopedTable> = Partial<ScopedInsert<T>>

/** A table's rows as one user sees them. Every query is limited to that user's rows. */
export interface ScopedRepository<T extends ScopedTable> {
  /** The user's rows matching `where`, or all of them without it. */
  list(where?: SQL): Promise<InferSelectModel<T>[]>
  /** The user's first row matching `where`; undefined means none. */
  find(where?: SQL): Promise<InferSelectModel<T> | undefined>
  /** Adds a row owned by the user and returns it. */
  insert(values: ScopedInsert<T>): Promise<InferSelectModel<T>>
  /** Changes the user's rows matching `where` and returns them. Throws if `values` carries a `userId`. */
  update(where: SQL | undefined, values: ScopedUpdate<T>): Promise<InferSelectModel<T>[]>
  /** Deletes the user's rows matching `where` and returns them. */
  delete(where: SQL | undefined): Promise<InferSelectModel<T>[]>
}

/**
 * Returns a repository for `table` that only ever reads, writes and deletes
 * rows whose `userId` is `userId`. The caller's `where` is ANDed with that
 * condition, so it can narrow the rows but never widen them.
 */
export function scopedRepository<T extends ScopedTable>(
  db: AnyPgDatabase,
  table: T,
  userId: string,
): ScopedRepository<T> {
  const owned = (where?: SQL) => and(eq(table.userId, userId), where)
  // Drizzle can't follow a generic table through its builders, so rows are typed here at the boundary.
  type Row = InferSelectModel<T>
  const anyTable = table as PgTable

  return {
    async list(where) {
      return (await db.select().from(anyTable).where(owned(where))) as Row[]
    },
    async find(where) {
      const rows = await db.select().from(anyTable).where(owned(where)).limit(1)
      return rows[0] as Row | undefined
    },
    async insert(values) {
      // `userId` goes last so one smuggled in through a cast is overwritten.
      const row = { ...values, userId }
      const [inserted] = await db.insert(anyTable).values(row).returning()
      return inserted as Row
    },
    async update(where, values) {
      if ('userId' in values) throw new Error('A scoped update cannot change `userId`.')
      return (await db.update(anyTable).set(values).where(owned(where)).returning()) as Row[]
    },
    async delete(where) {
      return (await db.delete(anyTable).where(owned(where)).returning()) as Row[]
    },
  }
}

/**
 * Names of the schema exports that are tables with a `userId` column but are
 * neither registered in `scopedTables` nor named in `exemptNames`. Anything
 * listed here could be read without the per-user check.
 */
export function findUnscopedTables(
  schemaExports: Record<string, unknown>,
  scopedTables: Record<string, PgTable>,
  exemptNames: readonly string[],
): string[] {
  const registered = new Set<unknown>(Object.values(scopedTables))
  return Object.entries(schemaExports)
    .filter(([name, value]) => is(value, PgTable) && 'userId' in getTableColumns(value) && !exemptNames.includes(name))
    .filter(([, value]) => !registered.has(value))
    .map(([name]) => name)
}
