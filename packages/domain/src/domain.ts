import { createDb, type Db } from './db'
import { type AnyPgDatabase, type ScopedRepository, type ScopedTable, scopedRepository } from './scoped'
import { type ScopedTables, scopedTables } from './scoped-tables'

/** Who a request acts for. Every scoped query is limited to this user's rows. */
export interface Principal {
  userId: string
}

/** One scoped repository per registered table, named as in the registry. */
export type ScopedRepositories<Tables extends Record<string, ScopedTable>> = {
  [K in keyof Tables]: ScopedRepository<Tables[K]>
}

/** Options for `createDomain`. */
export interface DomainOptions {
  /** Receives the line logged on each `skipAuthorization` call. Defaults to `console.warn`. */
  log?: (message: string) => void
}

/** The only way into the database for app code. */
export interface Domain<Tables extends Record<string, ScopedTable> = ScopedTables, Client = Db> {
  /** Repositories that only see and change `principal`'s rows. Throws without a `userId`. */
  forUser(principal: Principal): ScopedRepositories<Tables>
  /**
   * The raw client with the schema attached, for Better Auth's `drizzleAdapter`
   * only. It is not logged, since Better Auth uses it on every request. Never
   * hand it to app code.
   */
  forAuthLibrary(): Client
  /**
   * The raw client, which sees every user's rows. `reason` must say why the
   * per-user check is skipped; it is logged on every call, so never put
   * secrets in it. Throws when `reason` is blank.
   */
  skipAuthorization(reason: string): Client
  /** Closes the connection. */
  close(): Promise<void>
}

/** Builds a `Domain` around an open client. Shared by `createDomain` and `createTestDomain`. */
export function buildDomain<Tables extends Record<string, ScopedTable>, Client extends AnyPgDatabase>(
  db: Client,
  tables: Tables,
  close: () => Promise<void>,
  log: (message: string) => void = console.warn,
): Domain<Tables, Client> {
  return {
    forUser(principal) {
      const userId = principal?.userId
      if (typeof userId !== 'string' || userId === '') throw new Error('forUser needs a principal with a `userId`.')
      const repositories: Record<string, ScopedRepository<ScopedTable>> = {}
      for (const [name, table] of Object.entries(tables)) repositories[name] = scopedRepository(db, table, userId)
      return repositories as ScopedRepositories<Tables>
    },
    forAuthLibrary: () => db,
    skipAuthorization(reason) {
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new Error('skipAuthorization needs a reason.')
      }
      log(`skipAuthorization: ${reason.trim()}`)
      return db
    },
    close,
  }
}

/** Connects to the Postgres at `url` on Bun's built-in SQL driver and returns its `Domain`. */
export function createDomain(url: string, options: DomainOptions = {}): Domain {
  const db = createDb(url)
  return buildDomain(db, scopedTables, () => db.$client.close(), options.log)
}
