import { afterEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { schema } from './index'
import { createTestDomain } from './testing'

// A test-only table owned by one user. It is never added to `src/schemas/`, so no migration is generated for it.
const notes = pgTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => schema.user.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
})

const open: { close: () => Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((domain) => domain.close()))
})

/** A domain with `notes` registered, users `a` and `b`, and one note each (`na`, `nb`). */
async function setup() {
  const logged: string[] = []
  const domain = await createTestDomain({ scopedTables: { notes }, log: (message) => logged.push(message) })
  open.push(domain)
  const db = domain.forAuthLibrary()
  await db.execute(
    sql`CREATE TABLE notes (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      body text NOT NULL
    )`,
  )
  await db.insert(schema.user).values([
    { id: 'a', name: 'Ada', email: 'ada@example.com' },
    { id: 'b', name: 'Bob', email: 'bob@example.com' },
  ])
  await db.insert(notes).values([
    { id: 'na', userId: 'a', body: 'from a' },
    { id: 'nb', userId: 'b', body: 'from b' },
  ])
  const allNotes = () => db.select().from(notes).orderBy(notes.id)
  return { domain, logged, allNotes, a: domain.forUser({ userId: 'a' }).notes }
}

describe('forUser', () => {
  test("never reads another user's rows, even when the where targets them", async () => {
    const { a } = await setup()
    expect(await a.list()).toEqual([{ id: 'na', userId: 'a', body: 'from a' }])
    expect(await a.list(eq(notes.id, 'nb'))).toEqual([])
    expect(await a.find(eq(notes.id, 'nb'))).toBeUndefined()
    expect(await a.find(eq(notes.id, 'na'))).toMatchObject({ id: 'na' })
  })

  test("never updates or deletes another user's rows", async () => {
    const { a, allNotes } = await setup()
    expect(await a.update(eq(notes.id, 'nb'), { body: 'hacked' })).toEqual([])
    expect(await a.delete(eq(notes.id, 'nb'))).toEqual([])
    expect(await a.update(undefined, { body: 'edited' })).toEqual([{ id: 'na', userId: 'a', body: 'edited' }])
    expect(await allNotes()).toEqual([
      { id: 'na', userId: 'a', body: 'edited' },
      { id: 'nb', userId: 'b', body: 'from b' },
    ])
    expect(await a.delete(eq(notes.id, 'na'))).toMatchObject([{ id: 'na' }])
    expect(await allNotes()).toEqual([{ id: 'nb', userId: 'b', body: 'from b' }])
  })

  test('writes always keep the row with its owner', async () => {
    const { a, allNotes } = await setup()
    // @ts-expect-error `userId` is not accepted on insert.
    await a.insert({ id: 'n1', body: 'typed', userId: 'b' })
    await a.insert({ id: 'n2', body: 'smuggled', ...({ userId: 'b' } as object) })
    // @ts-expect-error `userId` is not accepted on update.
    await expect(a.update(eq(notes.id, 'na'), { userId: 'b' })).rejects.toThrow()
    const owners = Object.fromEntries((await allNotes()).map((note) => [note.id, note.userId]))
    expect(owners).toEqual({ na: 'a', n1: 'a', n2: 'a', nb: 'b' })
  })

  test('throws without a userId', async () => {
    const { domain } = await setup()
    expect(() => domain.forUser({ userId: '' })).toThrow()
    expect(() => domain.forUser({} as { userId: string })).toThrow()
  })
})

describe('skipAuthorization', () => {
  test('throws on a blank reason and logs nothing', async () => {
    const { domain, logged } = await setup()
    expect(() => domain.skipAuthorization('')).toThrow()
    expect(() => domain.skipAuthorization('   ')).toThrow()
    expect(logged).toEqual([])
  })

  test("returns a client that reads every user's rows and logs the reason once", async () => {
    const { domain, logged } = await setup()
    const db = domain.skipAuthorization('backfill machines')
    expect(await db.select({ id: notes.id }).from(notes).orderBy(notes.id)).toEqual([{ id: 'na' }, { id: 'nb' }])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('backfill machines')
  })
})

describe('forAuthLibrary', () => {
  test('returns a client with the schema for typed selects', async () => {
    const { domain } = await setup()
    const users = await domain.forAuthLibrary().select({ email: schema.user.email }).from(schema.user)
    expect(users.map((u) => u.email).sort()).toEqual(['ada@example.com', 'bob@example.com'])
  })
})
