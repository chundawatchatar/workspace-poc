import { afterEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { checkMigrations, migrationsFolder } from './migrations'

const open: PGlite[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()))
})

describe('checkMigrations', () => {
  test('lists every migration before `migrate` and none after', async () => {
    const client = new PGlite()
    open.push(client)
    const db = drizzle({ client })
    expect(await checkMigrations(db)).toEqual(['0000_better_auth', '0001_machines'])
    await migrate(db, { migrationsFolder })
    expect(await checkMigrations(db)).toEqual([])
  })
})
