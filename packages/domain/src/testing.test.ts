import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { session, user } from './schemas'
import { createTestDb, type TestDb } from './testing'

const open: TestDb[] = []

async function setup() {
  const db = await createTestDb()
  open.push(db)
  return db
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()))
})

function insertUser(db: TestDb, id: string, email: string) {
  return db.insert(user).values({ id, name: 'Ada', email })
}

describe('createTestDb', () => {
  test('stores a user and their session and reads them back', async () => {
    const db = await setup()
    await insertUser(db, 'u1', 'ada@example.com')
    const expiresAt = new Date(Date.now() + 60_000)
    await db.insert(session).values({ id: 's1', token: 't1', userId: 'u1', expiresAt })

    const users = await db.select().from(user)
    expect(users).toMatchObject([{ id: 'u1', email: 'ada@example.com', emailVerified: false }])
    const found = await db.query.user.findFirst({ where: eq(user.id, 'u1'), with: { sessions: true } })
    expect(found?.sessions).toMatchObject([{ id: 's1', token: 't1' }])
  })

  test('rejects a second user with the same email', async () => {
    const db = await setup()
    await insertUser(db, 'u1', 'ada@example.com')
    await expect(insertUser(db, 'u2', 'ada@example.com').execute()).rejects.toThrow()
    expect(await db.select().from(user)).toHaveLength(1)
  })

  test('deleting a user deletes their sessions', async () => {
    const db = await setup()
    await insertUser(db, 'u1', 'ada@example.com')
    await db.insert(session).values({ id: 's1', token: 't1', userId: 'u1', expiresAt: new Date() })
    await db.delete(user).where(eq(user.id, 'u1'))
    expect(await db.select().from(session)).toEqual([])
  })

  test('each database is isolated from the others', async () => {
    const first = await setup()
    const second = await setup()
    await insertUser(first, 'u1', 'ada@example.com')
    expect(await second.select().from(user)).toEqual([])
  })
})
