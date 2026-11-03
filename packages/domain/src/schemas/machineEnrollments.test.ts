import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createTestDomain, type TestDomain } from '../testing'
import { machineEnrollments } from './machineEnrollments'
import { user } from './user'

const open: TestDomain[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((domain) => domain.close()))
})

describe('machineEnrollments table', () => {
  test('refuses a repeated key hash across users, starts unused and goes with its user', async () => {
    const domain = await createTestDomain({ log: () => {} })
    open.push(domain)
    const db = domain.forAuthLibrary()
    await db.insert(user).values([
      { id: 'a', name: 'Ada', email: 'ada@example.com' },
      { id: 'b', name: 'Bob', email: 'bob@example.com' },
    ])
    const expiresAt = new Date(Date.now() + 60_000)
    const row = await domain.forUser({ userId: 'a' }).machineEnrollments.insert({ keyHash: 'h1', expiresAt })
    expect(row).toMatchObject({ userId: 'a', keyHash: 'h1', usedAt: null })

    const bob = domain.forUser({ userId: 'b' }).machineEnrollments
    await expect(bob.insert({ keyHash: 'h1', expiresAt })).rejects.toThrow()
    await bob.insert({ keyHash: 'h2', expiresAt })

    await db.delete(user).where(eq(user.id, 'a'))
    expect(await db.select({ keyHash: machineEnrollments.keyHash }).from(machineEnrollments)).toEqual([
      { keyHash: 'h2' },
    ])
  })
})
