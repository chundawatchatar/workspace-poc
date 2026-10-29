import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schemas'

/** Creates a Drizzle client for the Postgres at `url`, on Bun's built-in SQL driver, with the schema attached. */
export function createDb(url: string) {
  return drizzle({ client: new SQL(url), schema })
}

/** A Drizzle client from `createDb`. Its connection pool is `db.$client`; call `db.$client.close()` when done. */
export type Db = ReturnType<typeof createDb>
